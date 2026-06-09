// Claude Code Stop hook: send an email when a turn finishes.
// Reads hook input JSON from stdin (session_id, stop_hook_active, reason,
// transcript_path, cwd, model).
// Reads SMTP creds from .env in this script's directory.
// Always exits 0 — never blocks Claude, never crashes the hook.
//
// Wiring: ~/.claude/settings.json -> hooks.Stop -> node ~/.claude/hooks/notify-email.mjs

import { createRequire } from 'node:module';
import {
  appendFileSync,
  closeSync,
  existsSync,
  openSync,
  readSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env if present (no-op if missing).
try {
  const dotenv = require('dotenv');
  dotenv.config({ path: join(__dirname, '.env'), quiet: true });
} catch {
  // dotenv missing -> fall through; env vars must be set in the shell.
}

const nodemailer = require('nodemailer');

// ---- read stdin ----------------------------------------------------------
async function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    if (process.stdin.isTTY) return resolve(data);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
  });
}

// ---- one-time "not configured" hint -------------------------------------
let warnedMissing = false;

// ---- transcript reading --------------------------------------------------
function findTranscript(sessionId) {
  if (!sessionId || sessionId === 'unknown-session') return null;
  const projectsDir = join(homedir(), '.claude', 'projects');
  if (!existsSync(projectsDir)) return null;
  let entries;
  try {
    entries = readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = join(projectsDir, entry.name, `${sessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function extractText(content) {
  if (typeof content === 'string') return content.trim() || null;
  if (Array.isArray(content)) {
    const parts = [];
    for (const block of content) {
      if (block && block.type === 'text' && typeof block.text === 'string') {
        parts.push(block.text);
      }
    }
    const joined = parts.join('\n').trim();
    return joined || null;
  }
  return null;
}

function countTools(content, counts) {
  if (typeof content === 'string') return;
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (block && block.type === 'tool_use' && typeof block.name === 'string') {
      counts[block.name] = (counts[block.name] || 0) + 1;
    }
  }
}

// State machine (scanning backwards):
//   LOOKING_FOR_ASSISTANT -> found assistant with text -> COUNTING_TOOLS
//   COUNTING_TOOLS: count tool_use & tokens in any assistant message;
//                    stop on first user message that has text.
// Skips user entries that are only tool_result (no text block).
// Also collects token usage and model from assistant messages in the turn.
// Never throws.
function readLastMessages(transcriptPath) {
  const empty = {
    user: { text: null, ts: null },
    assistant: { text: null, ts: null },
    toolUseCounts: {},
    tokenUsage: null,
    model: null,
  };
  if (!transcriptPath) return empty;
  try {
    const stat = statSync(transcriptPath);
    const TAIL_BYTES = 200_000;
    const start = Math.max(0, stat.size - TAIL_BYTES);
    const length = stat.size - start;
    const buf = Buffer.alloc(length);
    const fd = openSync(transcriptPath, 'r');
    try {
      readSync(fd, buf, 0, length, start);
    } finally {
      try { closeSync(fd); } catch {}
    }
    const lines = buf.toString('utf8').split('\n').filter((l) => l.trim());

    let userText = null;
    let userTs = null;
    let assistantText = null;
    let assistantTs = null;
    const toolUseCounts = {};
    let tokenIn = 0;
    let tokenOut = 0;
    let model = null;
    let phase = 'looking'; // 'looking' | 'counting'

    for (let i = lines.length - 1; i >= 0; i--) {
      let msg;
      try { msg = JSON.parse(lines[i]); } catch { continue; }
      const role = msg.type || msg.message?.role;

      if (phase === 'looking') {
        if (role === 'assistant') {
          const t = extractText(msg.message?.content);
          if (t) {
            assistantText = t;
            assistantTs = typeof msg.timestamp === 'string' ? msg.timestamp : null;
            phase = 'counting';
          }
          countTools(msg.message?.content, toolUseCounts);
          // Collect token usage & model
          const u = msg.usage || msg.message?.usage;
          if (u && typeof u.input_tokens === 'number') tokenIn += u.input_tokens;
          if (u && typeof u.output_tokens === 'number') tokenOut += u.output_tokens;
          if (!model) model = msg.model || msg.message?.model || null;
        }
      } else if (phase === 'counting') {
        if (role === 'assistant') {
          countTools(msg.message?.content, toolUseCounts);
          const u = msg.usage || msg.message?.usage;
          if (u && typeof u.input_tokens === 'number') tokenIn += u.input_tokens;
          if (u && typeof u.output_tokens === 'number') tokenOut += u.output_tokens;
          if (!model) model = msg.model || msg.message?.model || null;
        } else if (role === 'user') {
          const t = extractText(msg.message?.content);
          if (t) {
            userText = t;
            userTs = typeof msg.timestamp === 'string' ? msg.timestamp : null;
            break;
          }
        }
      }
    }

    const tokenUsage = (tokenIn > 0 || tokenOut > 0)
      ? { input: tokenIn, output: tokenOut }
      : null;

    return { user: { text: userText, ts: userTs }, assistant: { text: assistantText, ts: assistantTs }, toolUseCounts, tokenUsage, model };
  } catch (e) {
    process.stderr.write(`[notify-email] transcript read failed: ${e.message}\n`);
    return empty;
  }
}

function truncate(s, max) {
  if (!s) return s;
  return s.length > max ? `${s.slice(0, max)}\n…(truncated)` : s;
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return rem ? `${m}m ${rem}s` : `${m}m`;
}

function tzNow() {
  const tz = process.env.NOTIFY_TIMEZONE || 'Asia/Shanghai';
  const s = new Date().toLocaleString('sv-SE', { timeZone: tz });
  return `${s} ${tz}`;
}

const REASON_LABELS = {
  end_turn: 'Done',
  interrupted: 'Interrupted',
  max_turns: 'Max turns',
  error: 'Error',
};

function formatToolSummary(counts) {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return null;
  return entries.map(([name, count]) => `${name}×${count}`).join(', ');
}

// Pricing per 1M tokens (USD). Used for cost estimate in email body.
const MODEL_PRICING = {
  'claude-opus-4-8':             { input: 15, output: 75 },
  'claude-opus-4-7':             { input: 15, output: 75 },
  'claude-opus-4-6':             { input: 15, output: 75 },
  'claude-opus-4-5-20251001':    { input: 15, output: 75 },
  'claude-sonnet-4-6':           { input:  3, output: 15 },
  'claude-sonnet-4-5-20251001':  { input:  3, output: 15 },
  'claude-haiku-4-5-20251001':   { input: 0.8, output: 4 },
};
const DEFAULT_PRICING = { input: 3, output: 15 }; // assume Sonnet-level

function formatTokenUsage(usage, model) {
  if (!usage) return null;
  const price = MODEL_PRICING[model] || DEFAULT_PRICING;
  const cost = (usage.input / 1_000_000) * price.input
             + (usage.output / 1_000_000) * price.output;
  const parts = [`${usage.input.toLocaleString()} in / ${usage.output.toLocaleString()} out`];
  if (cost > 0) parts.push(`~$${cost.toFixed(cost < 0.01 ? 4 : 2)}`);
  return parts.join(' · ');
}

// ---- logging -------------------------------------------------------------
const LOG_PATH = join(__dirname, 'notify-email.log');
function log(level, msg) {
  try {
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] [${level}] ${msg}\n`);
  } catch (e) {
    process.stderr.write(`[notify-email] log write failed: ${e.message}\n`);
  }
}

// ---- HTML utilities ------------------------------------------------------
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Lightweight Markdown → HTML renderer for email bodies.
// Handles: fenced code blocks, inline code, bold, italic, links,
// headings, lists, and blockquotes. Output uses inline styles
// compatible with Gmail/Outlook.
function renderMarkdown(text) {
  if (!text) return '';

  // Phase 1: extract fenced code blocks to placeholders.
  const codeBlocks = [];
  let html = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push({ lang, code: code.trimEnd() });
    return `\x00CB${idx}\x00`;
  });

  // Phase 2: HTML-escape remaining text.
  html = escapeHtml(html);

  // Phase 3: inline formatting.
  html = html.replace(/`([^`\n]+)`/g,
    '<code style="background:#e4e4e7;padding:1px 4px;border-radius:3px;font-family:monospace;font-size:13px;">$1</code>');
  html = html.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g,
    '<a href="$2" style="color:#2563eb;text-decoration:none;">$1</a>');

  // Phase 4: block-level formatting (line by line).
  const lines = html.split('\n');
  const out = [];
  let inUl = false;
  let inOl = false;

  function closeList() {
    if (inUl) { out.push('</ul>'); inUl = false; }
    if (inOl) { out.push('</ol>'); inOl = false; }
  }

  for (const line of lines) {
    // Code block placeholder — pass through.
    if (line.startsWith('\x00CB')) { closeList(); out.push(line); continue; }

    // Heading.
    const h = line.match(/^(#{1,6}) (.+)$/);
    if (h) {
      closeList();
      const lv = h[1].length;
      const sz = {1:'20px',2:'18px',3:'16px',4:'14px',5:'13px',6:'12px'}[lv] || '14px';
      out.push(`<div style="font-size:${sz};color:#18181b;font-weight:600;margin:8px 0 4px 0;">${h[2]}</div>`);
      continue;
    }

    // Unordered list.
    const ul = line.match(/^[\-\*] (.+)$/);
    if (ul) {
      if (!inUl) { closeList(); out.push('<ul style="margin:4px 0;padding-left:20px;">'); inUl = true; }
      out.push(`<li style="margin:2px 0;line-height:1.6;">${ul[1]}</li>`);
      continue;
    }

    // Ordered list.
    const ol = line.match(/^\d+\. (.+)$/);
    if (ol) {
      if (!inOl) { closeList(); out.push('<ol style="margin:4px 0;padding-left:20px;">'); inOl = true; }
      out.push(`<li style="margin:2px 0;line-height:1.6;">${ol[1]}</li>`);
      continue;
    }

    // Blockquote.
    const bq = line.match(/^> (.+)$/);
    if (bq) {
      closeList();
      out.push(`<blockquote style="border-left:3px solid #d4d4d8;padding-left:12px;margin:4px 0;color:#71717a;">${bq[1]}</blockquote>`);
      continue;
    }

    // Blank line.
    if (line.trim() === '') { closeList(); out.push('<br>'); continue; }

    // Regular text.
    closeList();
    out.push(line);
  }
  closeList();

  html = out.join('\n');

  // Phase 5: restore code blocks as styled <pre> blocks.
  html = html.replace(/\x00CB(\d+)\x00/g, (_, idx) => {
    const { lang, code } = codeBlocks[idx];
    const langLabel = lang
      ? `<div style="font-size:10px;color:#a1a1aa;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">${escapeHtml(lang)}</div>`
      : '';
    return `<pre style="background:#f4f4f5;padding:10px 14px;border-radius:4px;overflow-x:auto;font-family:monospace;font-size:13px;line-height:1.5;margin:0;">${langLabel}<code>${escapeHtml(code)}</code></pre>`;
  });

  return html;
}

// ---- email body builders -------------------------------------------------
function buildText(p) {
  const BAR = '─'.repeat(60);
  const lines = [];
  lines.push(BAR);
  lines.push(`  Claude Code  ·  ${p.reasonLabel}`);
  lines.push(BAR);
  lines.push('');

  if (p.lastUser) {
    lines.push('  ▎ TASK · your prompt');
    lines.push('  ' + p.lastUser);
    lines.push('');
  }
  if (p.lastAssistant) {
    const tag = p.reason === 'error' ? 'ERROR' : 'DONE';
    lines.push(`  ▎ ${tag} · last response${p.truncatedAssistant ? ' (truncated)' : ''}`);
    lines.push('  ' + p.lastAssistant);
    lines.push('');
  }
  if (p.toolSummary) {
    lines.push(`  ▎ TOOLS · ${p.toolSummary}`);
    lines.push('');
  }

  lines.push('  ▎ META');
  lines.push(`    Status      ${p.reasonLabel}`);
  lines.push(`    Time        ${p.now}`);
  if (p.durationMs !== null) lines.push(`    Duration    ${formatDuration(p.durationMs)}`);
  if (p.tokenUsage) lines.push(`    Tokens      ${formatTokenUsage(p.tokenUsage, p.model)}`);
  lines.push(`    Session     ${p.sessionId}`);
  lines.push(`    Project     ${p.projectCwd}`);
  lines.push(`    Transcript  ${p.transcriptPath || '(not found)'}`);
  lines.push('');
  lines.push(BAR);
  return lines.join('\n');
}

function buildHtml(p) {
  const FONT_SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  const FONT_MONO = "'SF Mono',Menlo,Monaco,Consolas,'Courier New',monospace";

  const BG    = '#f4f4f5';
  const CARD  = '#ffffff';
  const BORDER = '#e4e4e7';
  const TEXT  = '#18181b';
  const MUTED = '#71717a';
  const SUBTLE = '#fafafa';
  const ACCENT = '#d4d4d8';

  // Error highlighting: red accent + light-red background.
  const isErr = p.reason === 'error';
  const errAccent  = '#ef4444';
  const errBg      = '#fef2f2';

  const section = (label, body, subNote = '', err = false) => `
    <tr><td style="padding:20px 28px 0 28px;">
      <div style="font-size:10px;letter-spacing:1.5px;color:${MUTED};text-transform:uppercase;font-weight:600;margin:0 0 8px 0;">${escapeHtml(label)}${subNote ? ` <span style="color:#a1a1aa;font-weight:400;letter-spacing:0.5px;">${escapeHtml(subNote)}</span>` : ''}</div>
      <div style="font-size:14px;line-height:1.6;color:${TEXT};background-color:${err ? errBg : SUBTLE};border-left:3px solid ${err ? errAccent : ACCENT};padding:12px 14px;font-family:${FONT_MONO};white-space:pre-wrap;word-wrap:break-word;overflow-wrap:break-word;margin:0;">${renderMarkdown(body)}</div>
    </td></tr>`;

  const metaRow = (k, v, raw = false) => `
    <tr>
      <td style="color:${MUTED};padding:4px 16px 4px 0;width:96px;vertical-align:top;font-family:${FONT_MONO};font-size:12px;line-height:1.5;">${escapeHtml(k)}</td>
      <td style="color:${TEXT};padding:4px 0;vertical-align:top;font-family:${FONT_MONO};font-size:12px;line-height:1.5;word-break:break-all;">${raw ? v : escapeHtml(v)}</td>
    </tr>`;

  const toolSection = p.toolSummary ? `
    <tr><td style="padding:14px 28px 0 28px;">
      <div style="font-size:10px;letter-spacing:1.5px;color:${MUTED};text-transform:uppercase;font-weight:600;margin:0 0 8px 0;">Tools</div>
      <div style="font-size:13px;line-height:1.5;color:${TEXT};background-color:${SUBTLE};border-left:3px solid ${ACCENT};padding:10px 14px;font-family:${FONT_MONO};margin:0;">${escapeHtml(p.toolSummary)}</div>
    </td></tr>` : '';

  // Status badge — red dot for errors.
  const statusBadge = isErr
    ? `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#ef4444;margin-right:6px;vertical-align:middle;"></span>${escapeHtml(p.reasonLabel)}`
    : escapeHtml(p.reasonLabel);

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background-color:${BG};font-family:${FONT_SANS};color:${TEXT};-webkit-font-smoothing:antialiased;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${BG};">
  <tr><td align="center" style="padding:24px 12px;">

    <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="background-color:${CARD};border:1px solid ${BORDER}${isErr ? ';border-top:3px solid ' + errAccent : ''};max-width:600px;width:100%;">

      <tr><td style="padding:22px 28px 18px 28px;border-bottom:1px solid ${BORDER};">
        <div style="font-size:11px;letter-spacing:1.5px;color:${MUTED};text-transform:uppercase;font-weight:600;margin:0;">Claude Code</div>
        <div style="font-size:20px;color:${TEXT};font-weight:600;margin:2px 0 0 0;line-height:1.3;">${escapeHtml(p.firstLine || p.reasonLabel)}</div>
      </td></tr>

      ${p.lastUser ? section('Task · your prompt', p.lastUser) : ''}
      ${p.lastAssistant ? section(isErr ? 'Error' : 'Done · last response', p.lastAssistant, p.truncatedAssistant ? '· truncated' : '', isErr) : ''}
      ${toolSection}

      <tr><td style="padding:24px 28px 26px 28px;">
        <div style="font-size:10px;letter-spacing:1.5px;color:${MUTED};text-transform:uppercase;font-weight:600;margin:0 0 10px 0;">Meta</div>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          ${metaRow('Status', statusBadge, true)}
          ${metaRow('Time', p.now)}
          ${p.durationMs !== null ? metaRow('Duration', formatDuration(p.durationMs)) : ''}
          ${p.tokenUsage ? metaRow('Tokens', formatTokenUsage(p.tokenUsage, p.model)) : ''}
          ${metaRow('Session', p.sessionId)}
          ${metaRow('Project', p.projectCwd)}
          ${metaRow('Transcript', p.transcriptPath || '(not found)')}
        </table>
      </td></tr>

    </table>

  </td></tr>
</table>
</body>
</html>`;
}

// ---- webhooks -------------------------------------------------------------
// Fire-and-forget webhook posts. Each is optional; failures are logged
// but never block the hook.

// Shared markdown body for webhook messages. Renders whatever data is available.
function webhookBody(p, status) {
  const lines = [];
  lines.push(`${status} **Claude Code · ${p.reasonLabel}**`);
  if (p.firstLine) lines.push(`> ${p.firstLine}`);
  lines.push('');
  if (p.lastUser) { lines.push(`📝 **Task**`); lines.push(p.lastUser.slice(0, 250)); lines.push(''); }
  if (p.lastAssistant) { lines.push(`✅ **Response**`); lines.push(p.lastAssistant.slice(0, 400)); lines.push(''); }
  if (p.toolSummary) lines.push(`🛠 **Tools:** ${p.toolSummary}`);
  if (p.durationMs !== null) lines.push(`⏱ **Duration:** ${formatDuration(p.durationMs)}`);
  if (p.tokenUsage) lines.push(`📊 **Tokens:** ${formatTokenUsage(p.tokenUsage, p.model)}`);
  lines.push(`🕐 ${p.now}`);
  lines.push(`📋 Session: \`${p.sessionId.slice(0, 8)}\` · Project: \`${p.projectCwd}\``);
  return lines.join('\n');
}

function webhookSlackPayload(p) {
  const status = p.reason === 'error' ? ':red_circle:' : p.reason === 'interrupted' ? ':yellow_circle:' : ':green_circle:';
  return { text: webhookBody(p, status) };
}

function webhookFeishuPayload(p) {
  const status = p.reason === 'error' ? '🔴' : p.reason === 'interrupted' ? '🟡' : '🟢';
  return {
    msg_type: 'interactive',
    card: {
      header: {
        title: { tag: 'plain_text', content: `Claude Code · ${p.reasonLabel}` },
        template: p.reason === 'error' ? 'red' : 'blue',
      },
      elements: [{ tag: 'div', text: { tag: 'lark_md', content: webhookBody(p, status) } }],
    },
  };
}

function webhookDingtalkPayload(p) {
  const status = p.reason === 'error' ? '🔴' : p.reason === 'interrupted' ? '🟡' : '🟢';
  return {
    msgtype: 'markdown',
    markdown: { title: `Claude Code · ${p.reasonLabel}`, text: webhookBody(p, status) },
  };
}

function webhookWecomPayload(p) {
  const status = p.reason === 'error' ? '🔴' : p.reason === 'interrupted' ? '🟡' : '🟢';
  return {
    msgtype: 'markdown',
    markdown: { content: webhookBody(p, status) },
  };
}

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? require('https') : require('http');
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 10_000,
    }, (res) => {
      res.on('data', () => {}); // drain — avoids dangling handles on Windows
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve();
        else reject(new Error(`${res.statusCode} ${res.statusMessage}`));
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function sendWebhooks(p) {
  const hooks = [
    { url: process.env.SLACK_WEBHOOK_URL,    build: webhookSlackPayload    },
    { url: process.env.FEISHU_WEBHOOK_URL,   build: webhookFeishuPayload },
    { url: process.env.DINGTALK_WEBHOOK_URL, build: webhookDingtalkPayload },
    { url: process.env.WECOM_WEBHOOK_URL,    build: webhookWecomPayload  },
  ].filter(h => h.url);

  if (hooks.length === 0) return;

  await Promise.allSettled(hooks.map(async ({ url, build }) => {
    try {
      await postJson(url, JSON.stringify(build(p)));
      log('INFO', `webhook result=ok url=${url.slice(0, 60)}...`);
    } catch (e) {
      process.stderr.write(`[notify-email] webhook failed (${url.slice(0, 40)}…): ${e.message}\n`);
      log('WARN', `webhook result=fail url=${url.slice(0, 60)}... error="${e.message}"`);
    }
  }));
}

// ---- main ----------------------------------------------------------------
(async () => {
  let input = {};
  try {
    const raw = await readStdin();
    if (raw.trim()) input = JSON.parse(raw);
  } catch (e) {
    process.stderr.write(`[notify-email] could not parse stdin: ${e.message}\n`);
  }

  const {
    SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS,
    EMAIL_FROM, EMAIL_TO, EMAIL_CC, EMAIL_BCC,
    SLACK_WEBHOOK_URL, FEISHU_WEBHOOK_URL, DINGTALK_WEBHOOK_URL, WECOM_WEBHOOK_URL,
  } = process.env;

  const hasEmailCfg = SMTP_HOST && SMTP_USER && SMTP_PASS && EMAIL_FROM && EMAIL_TO;
  const hasWebhookCfg = SLACK_WEBHOOK_URL || FEISHU_WEBHOOK_URL || DINGTALK_WEBHOOK_URL || WECOM_WEBHOOK_URL;

  if (!hasEmailCfg && !hasWebhookCfg) {
    if (!warnedMissing) {
      process.stderr.write(
        '[notify-email] Neither SMTP nor webhook configured. Copy .env.example to .env and fill in the values.\n',
      );
      warnedMissing = true;
    }
    log('WARN', 'No notification channels configured, exit');
    process.exit(0);
  }

  const sessionId = input.session_id || 'unknown-session';
  const shortId = String(sessionId).slice(0, 8);
  const now = tzNow();
  const projectCwd = input.cwd || process.cwd();
  const transcriptPath = input.transcript_path || findTranscript(sessionId);
  const last = readLastMessages(transcriptPath);
  const lastUser = last.user.text;
  const lastAssistant = last.assistant.text;
  const toolSummary = formatToolSummary(last.toolUseCounts);
  const model = last.model || input.model || null;
  const tokenUsage = last.tokenUsage;

  log('INFO', `session=${shortId}`);
  log('INFO', `transcript=${transcriptPath || 'NOT_FOUND'}`);
  log('INFO', `reason=${input.reason || 'unknown'}`);

  let durationMs = null;
  const u = Date.parse(last.user.ts || '');
  const a = Date.parse(last.assistant.ts || '');
  if (Number.isFinite(u) && Number.isFinite(a) && a >= u) durationMs = a - u;

  log('INFO', `user_text_len=${last.user.text?.length ?? 0} assistant_text_len=${last.assistant.text?.length ?? 0}`);
  log('INFO', `user_ts=${last.user.ts || 'null'} assistant_ts=${last.assistant.ts || 'null'} duration_ms=${durationMs ?? 'null'}`);
  if (toolSummary) log('INFO', `tools=${toolSummary}`);
  if (tokenUsage) log('INFO', `tokens_in=${tokenUsage.input} tokens_out=${tokenUsage.output} model=${model || 'unknown'}`);

  // Threshold filter.
  const isUrgent = input.reason === 'error' || input.reason === 'interrupted';
  let minMs = 300_000;
  const rawMin = process.env.NOTIFY_MIN_DURATION_MS;
  if (rawMin !== undefined && rawMin !== '') {
    const n = Number(rawMin);
    if (Number.isFinite(n) && n >= 0) minMs = n;
  }
  const tooShort = input.stop_hook_active === true;
  const knownButShort = !isUrgent && durationMs !== null && durationMs < minMs;
  if (tooShort || knownButShort) {
    const reason = tooShort
      ? 'stop_hook_active (re-invocation, no real new work)'
      : `task took ${formatDuration(durationMs)}, below ${formatDuration(minMs)} threshold`;
    process.stderr.write(`[notify-email] skipped: ${reason}\n`);
    log('WARN', `decision=skip reason="${reason}" threshold_ms=${minMs}`);
    process.exit(0);
  }

  log('INFO', `decision=send threshold_ms=${minMs} urgent=${isUrgent}`);

  const reason = input.reason || 'end_turn';
  const reasonLabel = REASON_LABELS[reason] || 'Done';
  const firstLine = (lastUser || '').split('\n')[0].slice(0, 60).trim();
  const subject = firstLine
    ? `[Claude Code] ${reasonLabel} · ${firstLine} · ${shortId}`
    : `[Claude Code] ${reasonLabel} · ${shortId}`;

  // Configurable truncation.
  let userMax = 1500;
  const rawUserMax = process.env.NOTIFY_USER_MAX;
  if (rawUserMax !== undefined && rawUserMax !== '') {
    const n = Number(rawUserMax);
    if (Number.isFinite(n) && n > 0) userMax = n;
  }
  let assistantMax = 800;
  const rawAssistantMax = process.env.NOTIFY_ASSISTANT_MAX;
  if (rawAssistantMax !== undefined && rawAssistantMax !== '') {
    const n = Number(rawAssistantMax);
    if (Number.isFinite(n) && n > 0) assistantMax = n;
  }

  const payload = {
    firstLine,
    lastUser: lastUser ? truncate(lastUser, userMax) : null,
    lastAssistant: lastAssistant ? truncate(lastAssistant, assistantMax) : null,
    durationMs, sessionId, now, projectCwd, transcriptPath,
    truncatedUser: !!lastUser && lastUser.length > userMax,
    truncatedAssistant: !!lastAssistant && lastAssistant.length > assistantMax,
    reasonLabel, reason, toolSummary, tokenUsage, model,
  };

  // ---- email ----
  if (hasEmailCfg) {
    try {
      const transporter = nodemailer.createTransport({
        host: SMTP_HOST,
        port: Number(SMTP_PORT) || 465,
        secure: String(SMTP_SECURE).toLowerCase() !== 'false',
        auth: { user: SMTP_USER, pass: SMTP_PASS },
        connectionTimeout: 20_000,
        socketTimeout: 20_000,
      });

      const mailOpts = {
        from: EMAIL_FROM, to: EMAIL_TO,
        subject,
        text: buildText(payload),
        html: buildHtml(payload),
      };
      if (EMAIL_CC) mailOpts.cc = EMAIL_CC;
      if (EMAIL_BCC) mailOpts.bcc = EMAIL_BCC;

      await transporter.sendMail(mailOpts);
      log('INFO', `email result=ok subject="${subject}"`);
    } catch (e) {
      process.stderr.write(`[notify-email] email send failed: ${e.message}\n`);
      log('ERROR', `email result=fail error="${e.message}"`);
    }
  }

  // ---- webhooks (fire-and-forget) ----
  await sendWebhooks(payload);

  process.exit(0);
})();
