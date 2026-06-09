// Claude Code Stop hook: send an email when a turn finishes.
// Reads hook input JSON from stdin (session_id, stop_hook_active).
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
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    // If stdin is empty / closed without data, resolve to '' after a tick.
    setTimeout(() => resolve(data), 200);
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

// Scan the tail of the transcript for the last user prompt and last
// assistant text response, with their ISO timestamps. Skips user entries
// that are only tool_result (no text block). Never throws — always
// returns {user: {text, ts}, assistant: {text, ts}} (text/ts possibly null).
function readLastMessages(transcriptPath) {
  const empty = { user: { text: null, ts: null }, assistant: { text: null, ts: null } };
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
    for (let i = lines.length - 1; i >= 0; i--) {
      let msg;
      try { msg = JSON.parse(lines[i]); } catch { continue; }
      const role = msg.type || msg.message?.role;
      if (!userText && role === 'user') {
        const t = extractText(msg.message?.content);
        if (t) {
          userText = t;
          userTs = typeof msg.timestamp === 'string' ? msg.timestamp : null;
        }
      } else if (!assistantText && role === 'assistant') {
        const t = extractText(msg.message?.content);
        if (t) {
          assistantText = t;
          assistantTs = typeof msg.timestamp === 'string' ? msg.timestamp : null;
        }
      }
      if (userText && assistantText) break;
    }
    return {
      user: { text: userText, ts: userTs },
      assistant: { text: assistantText, ts: assistantTs },
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

// "Now" formatted in China Standard Time (UTC+8) as "YYYY-MM-DD HH:MM:SS CST".
// sv-SE gives us the 24h ISO-like date; we append "CST" to make the zone
// explicit so the reader doesn't have to guess. Hardcoded to Asia/Shanghai
// per request — edit this one line if it ever needs to change.
function cstNow() {
  const s = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' });
  return `${s} CST`;
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
// All-in-one data passed to the template builders.
function buildPayload({ firstLine, lastUser, lastAssistant, durationMs, sessionId, now, projectCwd, transcriptPath, truncatedUser, truncatedAssistant }) {
  return { firstLine, lastUser, lastAssistant, durationMs, sessionId, now, projectCwd, transcriptPath, truncatedUser, truncatedAssistant };
}

// Plain-text fallback. Uses ASCII separators + 2-space indent + U+2502
// for the section bar — renders well in any monospace viewer including
// Gmail's "view original".
function buildText(p) {
  const BAR = '─'.repeat(60);
  const lines = [];
  lines.push(BAR);
  lines.push('  Claude Code  ·  Task complete');
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

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background-color:${BG};font-family:${FONT_SANS};color:${TEXT};-webkit-font-smoothing:antialiased;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${BG};">
  <tr><td align="center" style="padding:24px 12px;">

    <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="background-color:${CARD};border:1px solid ${BORDER};max-width:600px;width:100%;">

      <tr><td style="padding:22px 28px 18px 28px;border-bottom:1px solid ${BORDER};">
        <div style="font-size:11px;letter-spacing:1.5px;color:${MUTED};text-transform:uppercase;font-weight:600;margin:0;">Claude Code</div>
        <div style="font-size:20px;color:${TEXT};font-weight:600;margin:2px 0 0 0;line-height:1.3;">${escapeHtml(p.firstLine || 'Task complete')}</div>
      </td></tr>

      ${p.lastUser ? section('Task · your prompt', p.lastUser) : ''}
      ${p.lastAssistant ? section('Done · last response', p.lastAssistant, p.truncatedAssistant ? '· truncated' : '') : ''}

      <tr><td style="padding:24px 28px 26px 28px;">
        <div style="font-size:10px;letter-spacing:1.5px;color:${MUTED};text-transform:uppercase;font-weight:600;margin:0 0 10px 0;">Meta</div>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
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
  const now = cstNow();
  const projectCwd = process.cwd();
  const transcriptPath = findTranscript(sessionId);
  const last = readLastMessages(transcriptPath);
  const lastUser = last.user.text;
  const lastAssistant = last.assistant.text;

  log('INFO', `session=${shortId}`);
  log('INFO', `transcript=${transcriptPath || 'NOT_FOUND'}`);

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

  // Threshold filter: skip short tasks. Default 5m; override with
  // NOTIFY_MIN_DURATION_MS in .env. If duration is unknown, send anyway
  // (no data → no filter). skip_hook_active also counts as "short" — it's
  // a re-invocation, not real work.
  // NOTE: `Number(x) || default` is wrong — `0 || default` is `default`.
  // Treat empty/unset as default; accept "0" as a valid value to disable.
  let minMs = 300_000;
  const rawMin = process.env.NOTIFY_MIN_DURATION_MS;
  if (rawMin !== undefined && rawMin !== '') {
    const n = Number(rawMin);
    if (Number.isFinite(n) && n >= 0) minMs = n;
  }
  const tooShort = input.stop_hook_active === true;
  const knownButShort = durationMs !== null && durationMs < minMs;
  if (tooShort || knownButShort) {
    const reason = tooShort
      ? 'stop_hook_active (re-invocation, no real new work)'
      : `task took ${formatDuration(durationMs)}, below ${formatDuration(minMs)} threshold`;
    process.stderr.write(`[notify-email] skipped: ${reason}\n`);
    log('WARN', `decision=skip reason="${reason}" threshold_ms=${minMs}`);
    process.exit(0);
  }

  log('INFO', `decision=send threshold_ms=${minMs}`);

  // Subject: include the first line of the task if available, else just session.
  const firstLine = (lastUser || '').split('\n')[0].slice(0, 60).trim();
  const subject = firstLine
    ? `[Claude Code] ${firstLine} - ${shortId}`
    : `[Claude Code] Task complete - ${shortId}`;

  // Apply truncation with explicit flags so templates can show "(truncated)".
  const USER_MAX = 1500;
  const ASSISTANT_MAX = 800;
  const truncatedUser = !!lastUser && lastUser.length > USER_MAX;
  const truncatedAssistant = !!lastAssistant && lastAssistant.length > ASSISTANT_MAX;
  const userText = lastUser ? truncate(lastUser, USER_MAX) : null;
  const assistantText = lastAssistant ? truncate(lastAssistant, ASSISTANT_MAX) : null;

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

    await transporter.sendMail({
      from: EMAIL_FROM,
      to: EMAIL_TO,
      subject,
      text,
      html,
    });
    log('INFO', `send result=ok subject="${subject}"`);
  } catch (e) {
    // Log but never fail the hook.
    process.stderr.write(`[notify-email] send failed: ${e.message}\n`);
    log('ERROR', `send result=failed error="${e.message}"`);
  }

  process.exit(0);
})();
