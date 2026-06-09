// Claude Code Stop hook: send an email when a turn finishes.
// Reads hook input JSON from stdin (session_id, stop_hook_active, reason,
// transcript_path, cwd).
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
    // If stdin is a TTY (interactive terminal, no pipe), no hook input is
    // coming — resolve immediately without waiting for a timeout.
    if (process.stdin.isTTY) return resolve(data);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
  });
}

// ---- one-time "not configured" hint -------------------------------------
let warnedMissing = false;

// ---- transcript reading --------------------------------------------------
// Locate the transcript file by session_id under ~/.claude/projects/*/.
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

// Extract text from a message.content (string or array of blocks).
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

// Count tool_use blocks in a message.content, accumulating into `counts`.
function countTools(content, counts) {
  if (typeof content === 'string') return;
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (block && block.type === 'tool_use' && typeof block.name === 'string') {
      counts[block.name] = (counts[block.name] || 0) + 1;
    }
  }
}

// Scan the tail of the transcript for the last user prompt, last assistant
// text response, and tool-call statistics from the same turn.
//
// State machine (scanning backwards):
//   LOOKING_FOR_ASSISTANT -> found assistant with text -> COUNTING_TOOLS
//   COUNTING_TOOLS: count tool_use in any assistant message; stop on
//                    first user message that has text.
//
// Skips user entries that are only tool_result (no text block).
// Never throws — always returns {user, assistant, toolUseCounts}.
function readLastMessages(transcriptPath) {
  const empty = {
    user: { text: null, ts: null },
    assistant: { text: null, ts: null },
    toolUseCounts: {},
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
          // Count tools even in the final assistant message (it may have
          // tool_use blocks alongside the text response).
          countTools(msg.message?.content, toolUseCounts);
        }
      } else if (phase === 'counting') {
        if (role === 'assistant') {
          countTools(msg.message?.content, toolUseCounts);
        } else if (role === 'user') {
          const t = extractText(msg.message?.content);
          if (t) {
            userText = t;
            userTs = typeof msg.timestamp === 'string' ? msg.timestamp : null;
            break;
          }
          // tool_result user messages have no text — skip them
        }
      }
    }

    return {
      user: { text: userText, ts: userTs },
      assistant: { text: assistantText, ts: assistantTs },
      toolUseCounts,
    };
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

// "Now" formatted per NOTIFY_TIMEZONE (default Asia/Shanghai, UTC+8).
// sv-SE gives us the 24h ISO-like date; we append the IANA zone id so
// the reader doesn't have to guess. Set NOTIFY_TIMEZONE in .env to
// override (e.g. "America/New_York", "Europe/London", "UTC").
function tzNow() {
  const tz = process.env.NOTIFY_TIMEZONE || 'Asia/Shanghai';
  const s = new Date().toLocaleString('sv-SE', { timeZone: tz });
  return `${s} ${tz}`;
}

// Human-readable labels for hook stop reasons.
const REASON_LABELS = {
  end_turn: 'Done',
  interrupted: 'Interrupted',
  max_turns: 'Max turns',
  error: 'Error',
};

// Format tool-use counts into a compact summary string.
// e.g. "Read×3, Write×1, Bash×2" or null if no tools were used.
function formatToolSummary(counts) {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return null;
  return entries.map(([name, count]) => `${name}×${count}`).join(', ');
}

// ---- logging -------------------------------------------------------------
// Append-only diagnostic log at ~/.claude/hooks/notify-email.log.
// Captures session, transcript location, computed duration, and the
// skip/send decision so you can diagnose "why was a short task sent?"
// or "why was a long task skipped?" without re-running the hook.
// Format: [ISO-timestamp] [LEVEL] key=value ...
const LOG_PATH = join(__dirname, 'notify-email.log');
function log(level, msg) {
  try {
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] [${level}] ${msg}\n`);
  } catch (e) {
    // Don't crash the hook if logging fails.
    process.stderr.write(`[notify-email] log write failed: ${e.message}\n`);
  }
}

// HTML escape for user/assistant content. Must run before any template
// interpolation — Claude's responses can contain <, >, & that would
// otherwise corrupt the email or trigger XSS-in-mail.
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---- email body builders -------------------------------------------------
// Plain-text fallback. Uses ASCII separators + 2-space indent + U+2502
// for the section bar — renders well in any monospace viewer including
// Gmail's "view original".
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
    lines.push(`  ▎ DONE · last response${p.truncatedAssistant ? ' (truncated)' : ''}`);
    lines.push('  ' + p.lastAssistant);
    lines.push('');
  }
  if (p.toolSummary) {
    lines.push(`  ▎ TOOLS · ${p.toolSummary}`);
    lines.push('');
  }

  lines.push('  ▎ META');
  lines.push(`    Time        ${p.now}`);
  if (p.durationMs !== null) lines.push(`    Duration    ${formatDuration(p.durationMs)}`);
  lines.push(`    Session     ${p.sessionId}`);
  lines.push(`    Project     ${p.projectCwd}`);
  lines.push(`    Transcript  ${p.transcriptPath || '(not found)'}`);
  lines.push('');
  lines.push(BAR);
  return lines.join('\n');
}

// HTML email. Table-based layout for Outlook compatibility. Inline styles
// only (Gmail strips <style> blocks in many cases). Monochrome palette so
// it reads well in dark mode without explicit @media queries.
function buildHtml(p) {
  const FONT_SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  const FONT_MONO = "'SF Mono',Menlo,Monaco,Consolas,'Courier New',monospace";

  // Color tokens
  const BG = '#f4f4f5';
  const CARD = '#ffffff';
  const BORDER = '#e4e4e7';
  const TEXT = '#18181b';
  const MUTED = '#71717a';
  const SUBTLE = '#fafafa';
  const ACCENT = '#d4d4d8';

  const section = (label, body, subNote = '') => `
    <tr><td style="padding:20px 28px 0 28px;">
      <div style="font-size:10px;letter-spacing:1.5px;color:${MUTED};text-transform:uppercase;font-weight:600;margin:0 0 8px 0;">${escapeHtml(label)}${subNote ? ` <span style="color:#a1a1aa;font-weight:400;letter-spacing:0.5px;">${escapeHtml(subNote)}</span>` : ''}</div>
      <div style="font-size:14px;line-height:1.6;color:${TEXT};background-color:${SUBTLE};border-left:3px solid ${ACCENT};padding:12px 14px;font-family:${FONT_MONO};white-space:pre-wrap;word-wrap:break-word;overflow-wrap:break-word;margin:0;">${escapeHtml(body)}</div>
    </td></tr>`;

  const metaRow = (k, v) => `
    <tr>
      <td style="color:${MUTED};padding:4px 16px 4px 0;width:96px;vertical-align:top;font-family:${FONT_MONO};font-size:12px;line-height:1.5;">${escapeHtml(k)}</td>
      <td style="color:${TEXT};padding:4px 0;vertical-align:top;font-family:${FONT_MONO};font-size:12px;line-height:1.5;word-break:break-all;">${escapeHtml(v)}</td>
    </tr>`;

  const toolSection = p.toolSummary ? `
    <tr><td style="padding:14px 28px 0 28px;">
      <div style="font-size:10px;letter-spacing:1.5px;color:${MUTED};text-transform:uppercase;font-weight:600;margin:0 0 8px 0;">Tools</div>
      <div style="font-size:13px;line-height:1.5;color:${TEXT};background-color:${SUBTLE};border-left:3px solid ${ACCENT};padding:10px 14px;font-family:${FONT_MONO};margin:0;">${escapeHtml(p.toolSummary)}</div>
    </td></tr>` : '';

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background-color:${BG};font-family:${FONT_SANS};color:${TEXT};-webkit-font-smoothing:antialiased;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${BG};">
  <tr><td align="center" style="padding:24px 12px;">

    <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="background-color:${CARD};border:1px solid ${BORDER};max-width:600px;width:100%;">

      <tr><td style="padding:22px 28px 18px 28px;border-bottom:1px solid ${BORDER};">
        <div style="font-size:11px;letter-spacing:1.5px;color:${MUTED};text-transform:uppercase;font-weight:600;margin:0;">Claude Code</div>
        <div style="font-size:20px;color:${TEXT};font-weight:600;margin:2px 0 0 0;line-height:1.3;">${escapeHtml(p.firstLine || p.reasonLabel)}</div>
      </td></tr>

      ${p.lastUser ? section('Task · your prompt', p.lastUser) : ''}
      ${p.lastAssistant ? section('Done · last response', p.lastAssistant, p.truncatedAssistant ? '· truncated' : '') : ''}
      ${toolSection}

      <tr><td style="padding:24px 28px 26px 28px;">
        <div style="font-size:10px;letter-spacing:1.5px;color:${MUTED};text-transform:uppercase;font-weight:600;margin:0 0 10px 0;">Meta</div>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          ${metaRow('Status', p.reasonLabel)}
          ${metaRow('Time', p.now)}
          ${p.durationMs !== null ? metaRow('Duration', formatDuration(p.durationMs)) : ''}
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

// ---- main ----------------------------------------------------------------
(async () => {
  let input = {};
  try {
    const raw = await readStdin();
    if (raw.trim()) input = JSON.parse(raw);
  } catch (e) {
    // Malformed stdin shouldn't kill the hook.
    process.stderr.write(`[notify-email] could not parse stdin: ${e.message}\n`);
  }

  const {
    SMTP_HOST,
    SMTP_PORT,
    SMTP_SECURE,
    SMTP_USER,
    SMTP_PASS,
    EMAIL_FROM,
    EMAIL_TO,
    EMAIL_CC,
    EMAIL_BCC,
  } = process.env;

  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !EMAIL_FROM || !EMAIL_TO) {
    if (!warnedMissing) {
      process.stderr.write(
        '[notify-email] SMTP not configured. Copy ~/.claude/hooks/.env.example to ~/.claude/hooks/.env and fill in the values.\n',
      );
      warnedMissing = true;
    }
    log('WARN', 'SMTP not configured, exit');
    process.exit(0);
  }

  const sessionId = input.session_id || 'unknown-session';
  const shortId = String(sessionId).slice(0, 8);
  const now = tzNow();

  // Prefer hook-provided values (newer Claude Code) with fallbacks.
  const projectCwd = input.cwd || process.cwd();
  const transcriptPath = input.transcript_path || findTranscript(sessionId);

  const last = readLastMessages(transcriptPath);
  const lastUser = last.user.text;
  const lastAssistant = last.assistant.text;
  const toolUseCounts = last.toolUseCounts;
  const toolSummary = formatToolSummary(toolUseCounts);

  log('INFO', `session=${shortId}`);
  log('INFO', `transcript=${transcriptPath || 'NOT_FOUND'}`);
  log('INFO', `reason=${input.reason || 'unknown'}`);

  // Duration: time from user's last text prompt to assistant's last text response.
  // Returns null if either timestamp is missing or unparseable.
  let durationMs = null;
  const u = Date.parse(last.user.ts || '');
  const a = Date.parse(last.assistant.ts || '');
  if (Number.isFinite(u) && Number.isFinite(a) && a >= u) {
    durationMs = a - u;
  }

  log('INFO', `user_text_len=${last.user.text?.length ?? 0} assistant_text_len=${last.assistant.text?.length ?? 0}`);
  log('INFO', `user_ts=${last.user.ts || 'null'} assistant_ts=${last.assistant.ts || 'null'} duration_ms=${durationMs ?? 'null'}`);
  if (toolSummary) log('INFO', `tools=${toolSummary}`);

  // Threshold filter: skip short tasks. Default 5m; override with
  // NOTIFY_MIN_DURATION_MS in .env. If duration is unknown, send anyway
  // (no data -> no filter). skip_hook_active also counts as "short" — it's
  // a re-invocation, not real work.
  //
  // NOTE: error / interrupted always send immediately regardless of
  // duration — you want to know about failures right away.
  //
  // NOTE: `Number(x) || default` is wrong — `0 || default` is `default`.
  // Treat empty/unset as default; accept "0" as a valid value to disable.
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

  // Subject: [Claude Code] <reasonLabel> · <first line of task> · <session>
  const reasonLabel = REASON_LABELS[input.reason] || 'Done';
  const firstLine = (lastUser || '').split('\n')[0].slice(0, 60).trim();
  const subject = firstLine
    ? `[Claude Code] ${reasonLabel} · ${firstLine} · ${shortId}`
    : `[Claude Code] ${reasonLabel} · ${shortId}`;

  // Configurable truncation limits (env vars override defaults).
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

  const truncatedUser = !!lastUser && lastUser.length > userMax;
  const truncatedAssistant = !!lastAssistant && lastAssistant.length > assistantMax;
  const userText = lastUser ? truncate(lastUser, userMax) : null;
  const assistantText = lastAssistant ? truncate(lastAssistant, assistantMax) : null;

  const payload = {
    firstLine,
    lastUser: userText,
    lastAssistant: assistantText,
    durationMs,
    sessionId,
    now,
    projectCwd,
    transcriptPath,
    truncatedUser,
    truncatedAssistant,
    reasonLabel,
    toolSummary,
  };

  const text = buildText(payload);
  const html = buildHtml(payload);

  try {
    const transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: Number(SMTP_PORT) || 465,
      secure: String(SMTP_SECURE).toLowerCase() !== 'false', // default true
      auth: { user: SMTP_USER, pass: SMTP_PASS },
      connectionTimeout: 20_000,
      socketTimeout: 20_000,
    });

    const mailOpts = {
      from: EMAIL_FROM,
      to: EMAIL_TO,
      subject,
      text,
      html,
    };
    if (EMAIL_CC) mailOpts.cc = EMAIL_CC;
    if (EMAIL_BCC) mailOpts.bcc = EMAIL_BCC;

    await transporter.sendMail(mailOpts);
    log('INFO', `send result=ok subject="${subject}"`);
  } catch (e) {
    // Log but never fail the hook.
    process.stderr.write(`[notify-email] send failed: ${e.message}\n`);
    log('ERROR', `send result=failed error="${e.message}"`);
  }

  process.exit(0);
})();
