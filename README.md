# Claude Code Notify Hook

A **Claude Code Stop hook** that sends notifications via **email** (SMTP) and/or **IM webhooks** (Slack, Feishu, DingTalk, WeCom) when a Claude Code turn finishes. It reads the last user prompt, assistant response, tool-use stats, and token/cost usage from the session transcript.

## Features

- 📧 **Email notifications** — plain-text and styled HTML emails with light Markdown rendering
- 💬 **IM webhooks** — Slack, Feishu (Lark), DingTalk, and WeCom (WeChat Work)
- 🔴 **Error highlighting** — red accent borders and backgrounds for failed/errored turns
- ⏱ **Duration threshold** — skip notifications for short turns (configurable; errors/interruptions always send)
- 📊 **Token & cost stats** — input/output token counts with per-model cost estimates (Opus / Sonnet / Haiku)
- 🛠 **Tool usage summary** — per-turn tool call counts
- 🌐 **Timezone support** — configurable IANA timezone for timestamps (default: `Asia/Shanghai`)
- 🔇 **Always exits 0** — never blocks or crashes the Claude Code session

## Prerequisites

- [Node.js](https://nodejs.org/) ≥ 18
- An SMTP server or at least one webhook URL

## Installation

```bash
npm install -g claude-code-notify-email
claude-code-notify-email init
```

That's it — `init` creates `~/.claude/hooks/.env` (edit it with your credentials) and registers the Stop hook in `~/.claude/settings.json`.

### Manual install (no global install)

```bash
# Clone and install locally
git clone <repo-url> ~/.claude/hooks
cd ~/.claude/hooks
npm install

# Then wire the hook manually in ~/.claude/settings.json:
#   "hooks": { "Stop": "node ~/.claude/hooks/notify-email.mjs" }
```

### Using npx (zero-install)

```json
{
  "hooks": {
    "Stop": "npx -y claude-code-notify-email"
  }
}
```

Note: `npx` adds ~1s cold-start overhead per turn. Global install is recommended.

## Wiring

The `init` command writes this to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": "claude-code-notify-email"
  }
}
```

When installed globally, the `claude-code-notify-email` command is on your `PATH`. No absolute paths needed.

## Configuration

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

### Quick start — email only

```ini
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=you@gmail.com
SMTP_PASS=your-app-password
EMAIL_FROM="Claude Code <you@gmail.com>"
EMAIL_TO=you@gmail.com
```

### Quick start — webhook only

```ini
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
# or
FEISHU_WEBHOOK_URL=https://open.feishu.cn/open-apis/bot/v2/hook/...
# or
DINGTALK_WEBHOOK_URL=https://oapi.dingtalk.com/robot/send?access_token=...
# or
WECOM_WEBHOOK_URL=https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...
```

At least one channel (SMTP or webhook) must be configured. Email and webhooks can be used together.

## Environment variables

### SMTP (email)

| Variable | Required | Default | Description |
|---|---|---|---|
| `SMTP_HOST` | For email | — | SMTP server hostname |
| `SMTP_PORT` | No | `465` | SMTP port |
| `SMTP_SECURE` | No | `true` | Use TLS (`"false"` disables) |
| `SMTP_USER` | For email | — | SMTP auth username |
| `SMTP_PASS` | For email | — | SMTP auth password |
| `EMAIL_FROM` | For email | — | `From:` address |
| `EMAIL_TO` | For email | — | `To:` address |
| `EMAIL_CC` | No | — | `Cc:` recipients (comma-separated) |
| `EMAIL_BCC` | No | — | `Bcc:` recipients (comma-separated) |

### Webhooks

| Variable | Required | Description |
|---|---|---|
| `SLACK_WEBHOOK_URL` | No | Slack incoming webhook URL |
| `FEISHU_WEBHOOK_URL` | No | Feishu/Lark bot webhook URL |
| `DINGTALK_WEBHOOK_URL` | No | DingTalk bot webhook URL |
| `WECOM_WEBHOOK_URL` | No | WeCom (WeChat Work) bot webhook URL |

### Behavior

| Variable | Required | Default | Description |
|---|---|---|---|
| `NOTIFY_MIN_DURATION_MS` | No | `300000` (5 min) | Skip notifications for turns shorter than this. `0` = always notify. Ignored for `error`/`interrupted`. |
| `NOTIFY_TIMEZONE` | No | `Asia/Shanghai` | IANA timezone for timestamps in notifications |
| `NOTIFY_USER_MAX` | No | `1500` | Max characters of user prompt in notification body |
| `NOTIFY_ASSISTANT_MAX` | No | `800` | Max characters of assistant response in notification body |

## How it works

1. **Reads stdin** — receives hook input JSON from the Claude Code harness (`session_id`, `stop_hook_active`, `reason`, `transcript_path`, `cwd`, `model`)
2. **Loads `.env`** — via `dotenv`; fails silently if `dotenv` is missing
3. **Locates the transcript** — uses `transcript_path` from hook input if provided, otherwise searches `~/.claude/projects/*/` for `{session_id}.jsonl`
4. **Parses the transcript tail** (last 200 KB) — extracts the last user prompt, last assistant response, timestamps, tool-use counts, token usage, and model
5. **Computes duration** — difference between user timestamp and assistant timestamp
6. **Threshold filter** — skips if `stop_hook_active` or duration is below `NOTIFY_MIN_DURATION_MS`. `error`/`interrupted` reasons bypass the filter
7. **Builds notifications** — plain-text + HTML email (with Markdown rendering, error highlighting), plus webhook payloads for each configured platform
8. **Dispatches** — email via `nodemailer`, webhooks via `fetch`. Always exits 0

## Notification format

### Email

- **Subject line**: `[Claude Code] <Status> · <first line of prompt> · <session ID>`
- **Body sections**:
  - Task (your prompt)
  - Done / Error (last assistant response)
  - Tools (tool call summary)
  - Meta (status, time, duration, tokens, cost, session ID, project, transcript path)

HTML emails feature light Markdown rendering (code blocks, inline code, bold, italic, links, headings, lists, blockquotes) with inline styles compatible with Gmail and Outlook.

### Webhooks

Each platform receives a Markdown-formatted message with the same data fields, including:
- Status indicator (🟢/🔴/🟡)
- Task prompt and response excerpts
- Tool usage summary
- Duration and token/cost stats
- Session metadata

## CLI

```
claude-code-notify-email                  # Run as a hook (reads JSON from stdin)
claude-code-notify-email init             # Install hook config + .env template
claude-code-notify-email --help           # Show help
claude-code-notify-email --version        # Print version
```

## Programmatic use

The `notify()` function is exported and can be called from other scripts:

```js
import { notify } from 'claude-code-notify-email';

const result = await notify({
  session_id: 'abc123',
  reason: 'end_turn',
  cwd: '/path/to/project',
  transcript_path: '/path/to/transcript.jsonl',
});

console.log(result.status);  // 'sent' | 'skipped' | 'no_config'
```

## Testing

```bash
# Test with a minimal payload (no real notification unless configured)
echo '{"session_id":"test-123"}' | claude-code-notify-email

# Or during development:
echo '{"session_id":"test-123"}' | node notify-email.mjs
```

The hook logs activity to `~/.claude/hooks/notify-email.log`. Check it for troubleshooting:

```bash
tail -f ~/.claude/hooks/notify-email.log
```

## Design decisions

- **Always exits 0** — the hook must never fail the Claude Code session. All errors are logged to stderr and `notify-email.log`
- **Transcript tail-read** — only reads the last 200 KB of the `.jsonl` transcript file for speed
- **Light Markdown rendering** — HTML emails render fenced code blocks, inline code, bold, italic, links, headings, lists, and blockquotes with inline styles compatible with Gmail/Outlook. Plain-text fallback delivers raw markdown
- **Error highlighting** — when `reason=error`, the assistant response block gets a red accent border and light-red background; the email card gets a red top border; webhooks show a 🔴 status
- **Multi-channel** — email and webhooks can be used independently or together. Webhook dispatch is fire-and-forget; a single webhook failure doesn't affect others
- **Token & cost estimation** — parses `usage` objects from assistant messages for input/output token counts. Estimates cost using per-model pricing (Opus $15/$75, Sonnet $3/$15, Haiku $0.80/$4 per 1M tokens). Falls back to Sonnet pricing if the model is unknown
- **Urgent notifications** — `error` and `interrupted` reasons bypass the duration threshold and always send immediately

## License

MIT
