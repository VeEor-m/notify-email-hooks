# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

A **Claude Code Stop hook** — a single-file Node.js ES module (`notify-email.mjs`) that sends an HTML+plaintext email via SMTP when a Claude Code turn finishes. It reads the last user prompt and assistant response from the session transcript and includes them in the email body.

## Wiring

In `~/.claude/settings.json`, the hook is registered under `hooks.Stop`:

```json
"hooks": { "Stop": "node ~/.claude/hooks/notify-email.mjs" }
```

The script is designed to be deployed at `~/.claude/hooks/notify-email.mjs` with its `.env` and `node_modules` co-located there.

## Running / testing

```bash
# Install dependencies (one-time)
npm install

# Test the hook directly (it reads stdin for the hook payload)
echo '{"session_id":"abc123"}' | node notify-email.mjs
```

No build step, no linter, no test suite — it's a single script.

## How it works

1. **Reads stdin** — expects JSON with `session_id` and optionally `stop_hook_active` (injected by the Claude Code harness).
2. **Loads `.env`** via `dotenv` — fails silently if `dotenv` is missing (falls through to shell env vars).
3. **Locates the transcript** — searches `~/.claude/projects/*/` for `{session_id}.jsonl`.
4. **Parses the last N bytes** of the transcript (tail 200 KB) to extract the last user prompt and last assistant text response, plus their ISO timestamps.
5. **Computes duration** — difference between user prompt timestamp and assistant response timestamp.
6. **Threshold filter** — skips the email if:
   - `stop_hook_active` is `true` (re-invocation, not real work), or
   - Duration is below `NOTIFY_MIN_DURATION_MS` (default 300000 ms = 5 min).
7. **Builds email** — generates both `text/plain` (monospace-friendly) and `text/html` (table-based, inline styles for Gmail/Outlook) using the extracted prompt/response/meta.
8. **Sends via SMTP** using `nodemailer`, then **always exits 0** — the hook must never block or crash Claude Code.

## Configuration (.env)

| Variable | Required | Default | Notes |
|---|---|---|---|
| `SMTP_HOST` | Yes | — | SMTP server hostname |
| `SMTP_PORT` | Yes | `465` | SMTP port |
| `SMTP_SECURE` | No | `true` | TLS (`"false"` disables) |
| `SMTP_USER` | Yes | — | SMTP auth username |
| `SMTP_PASS` | Yes | — | SMTP auth password |
| `EMAIL_FROM` | Yes | — | `From:` address |
| `EMAIL_TO` | Yes | — | `To:` address |
| `NOTIFY_MIN_DURATION_MS` | No | `300000` | Minimum task duration in ms to trigger a notification. Set to `0` to notify on every turn. |

## Key design decisions

- **Always exits 0** — the hook must never fail the Claude Code session. All errors are logged to stderr and to `notify-email.log`.
- **Transcript tail-read** — only reads the last 200 KB of the `.jsonl` transcript file. This keeps the hook fast even for long sessions.
- **Content truncation** — user prompts capped at 1500 chars, assistant responses at 800 chars, to keep emails concise.
- **Timezone is hardcoded** — `cstNow()` uses `Asia/Shanghai` (UTC+8). Edit that one line if a different timezone is needed.
- **Logging** — append-only diagnostic log at `notify-email.log` next to the script. Captures session ID, transcript location, duration, and skip/send decisions.
- **HTML safety** — user and assistant content is HTML-escaped before interpolation to prevent broken markup or injection.
