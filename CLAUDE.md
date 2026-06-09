# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

A **Claude Code Stop hook** — a single-file Node.js ES module (`notify-email.mjs`) that sends notifications via **email** (SMTP) and/or **IM webhooks** (Slack, Feishu, DingTalk, WeCom) when a Claude Code turn finishes. It reads the last user prompt, assistant response, tool-use stats, and token usage from the session transcript.

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

1. **Reads stdin** — expects JSON with `session_id`, `stop_hook_active`, `reason`, `transcript_path`, `cwd`, `model` (injected by the Claude Code harness). If stdin is a TTY, resolves immediately.
2. **Loads `.env`** via `dotenv` — fails silently if `dotenv` is missing.
3. **Locates the transcript** — uses `transcript_path` from hook input if provided, otherwise searches `~/.claude/projects/*/` for `{session_id}.jsonl`.
4. **Parses the transcript tail** (200 KB) — extracts last user prompt, last assistant response, timestamps, tool-use counts, token usage, and model.
5. **Computes duration** — difference between user timestamp and assistant timestamp.
6. **Threshold filter** — skips if `stop_hook_active` or duration below `NOTIFY_MIN_DURATION_MS`. `error`/`interrupted` reasons bypass the filter.
7. **Builds notifications** — plain-text and HTML email (with light Markdown rendering, error highlighting), plus webhook payloads for Slack/Feishu/DingTalk/WeCom.
8. **Dispatches** — email via `nodemailer`, webhooks via `fetch`. Always exits 0.

## Configuration (.env)

| Variable | Required | Default | Notes |
|---|---|---|---|
| `SMTP_HOST` | Only if using email | — | SMTP server hostname |
| `SMTP_PORT` | No | `465` | SMTP port |
| `SMTP_SECURE` | No | `true` | TLS (`"false"` disables) |
| `SMTP_USER` | Only if using email | — | SMTP auth username |
| `SMTP_PASS` | Only if using email | — | SMTP auth password |
| `EMAIL_FROM` | Only if using email | — | `From:` address |
| `EMAIL_TO` | Only if using email | — | `To:` address |
| `EMAIL_CC` | No | — | `Cc:` address (comma-separated) |
| `EMAIL_BCC` | No | — | `Bcc:` address (comma-separated) |
| `SLACK_WEBHOOK_URL` | No | — | Slack incoming webhook URL |
| `FEISHU_WEBHOOK_URL` | No | — | Feishu bot webhook URL |
| `DINGTALK_WEBHOOK_URL` | No | — | DingTalk bot webhook URL |
| `WECOM_WEBHOOK_URL` | No | — | WeCom bot webhook URL |
| `NOTIFY_MIN_DURATION_MS` | No | `300000` | Min duration to notify. `0` = always. Ignored for `error`/`interrupted`. |
| `NOTIFY_TIMEZONE` | No | `Asia/Shanghai` | IANA timezone for timestamps |
| `NOTIFY_USER_MAX` | No | `1500` | Max chars of user prompt in body |
| `NOTIFY_ASSISTANT_MAX` | No | `800` | Max chars of assistant response in body |

At least one channel must be configured: SMTP or at least one webhook URL.

## Key design decisions

- **Always exits 0** — the hook must never fail the Claude Code session. All errors are logged to stderr and `notify-email.log`.
- **Transcript tail-read** — only reads the last 200 KB of the `.jsonl` transcript file for speed.
- **Light Markdown rendering** — HTML emails render fenced code blocks, inline code, bold, italic, links, headings, lists, and blockquotes with inline styles compatible with Gmail/Outlook. Plain-text fallback delivers raw markdown.
- **Error highlighting** — when `reason=error`, the assistant response block gets a red accent border and light-red background; the email card gets a red top border; webhooks show a 🔴 status.
- **Multi-channel** — email and webhooks can be used independently or together. Webhook dispatch is fire-and-forget; a single webhook failure doesn't affect others.
- **Token & cost estimation** — parses `usage` objects from assistant messages for input/output token counts. Estimates cost using per-model pricing (Opus $15/$75, Sonnet $3/$15, Haiku $0.80/$4 per 1M tokens). Falls back to Sonnet pricing if model is unknown.
- **Urgent notifications** — `error` and `interrupted` bypass the duration threshold and always send immediately.
- **Timezone configurable** — default `Asia/Shanghai` (UTC+8), override with `NOTIFY_TIMEZONE`.
