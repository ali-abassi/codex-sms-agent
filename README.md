# Codex SMS Agent

Text your Mac. An autonomous [OpenAI Codex](https://openai.com/codex/) agent runs on your own computer, reads your iMessage/SMS/RCS texts through [Sendblue](https://sendblue.com), does the work (runs commands, writes code, manages files, drives macOS apps), and texts you back like a person would.

```text
you:    can you check if the deploy finished and restart nginx if it did
agent:  deploy landed at 14:02, nginx restarted clean. 200s on /health.
```

Built on the official TypeScript `@openai/codex-sdk`. One durable Codex thread per conversation, so it remembers context across texts. Uses your ChatGPT subscription via `codex login`; no API key needed.

> **Read this first.** In active mode, every allowlisted phone number gets Codex with `danger-full-access`, no approval prompts, network access, and web search on your machine. Only allowlist numbers you fully trust, use a dedicated Sendblue line, and consider running it under a separate macOS user. See [SECURITY.md](SECURITY.md).

## What it does

- **Full computer control.** Bash, file read/write, code execution, `open`, `osascript`, Shortcuts, Hammerspoon if installed. Whatever you could do in a terminal, it can do.
- **Natural texting.** Replies as one to four short bubbles, never threaded replies, never AI-slop. Reactions, images, files, and carousels when they fit.
- **Persistent memory per conversation.** Direct threads and group chats each keep their own Codex thread. `/clear` wipes it.
- **Photos in.** Send a screenshot or photo and it's passed to Codex as an image input.
- **Routines.** "Check the build every 2 hours and text me if it breaks" creates a durable scheduled job. Ask naturally to list, change, or delete them.
- **Bulletproof delivery.** Webhook plus polling reconciliation, SQLite dedup and queue, crash recovery, graceful shutdown that re-queues in-flight work, and a fallback text if something goes wrong.
- **Control commands that always work**, even mid-task: `/clear`, `/restart`, `/status`, `/help`.
- **Your own instructions.** Add anything you want below the managed block in the workspace `AGENTS.md` (your tools, your preferences, your house rules) and it's honored every turn.

## Requirements

- macOS (Linux works for the daemon; the Mac automation parts are macOS-only)
- Node.js 22.13+
- A [Sendblue](https://sendblue.com) account with a dedicated iMessage/SMS number
- A ChatGPT plan with Codex access, and the Codex CLI logged in:

```bash
npm install -g @openai/codex
codex login
codex login status   # must say: Logged in using ChatGPT
```

## Install

```bash
git clone https://github.com/ali-abassi/codex-sms-agent.git
cd codex-sms-agent
npm ci
npm run build
npm link
codex-sms-agent setup
codex-sms-agent doctor
```

`setup` asks for your Sendblue keys, your Sendblue number, the phone number(s) allowed to control the machine, and your first name, and writes a mode-0600 config to `~/.config/codex-sms-agent/config.json`. Nothing goes in an `.env` file.

## Expose the webhook

Sendblue needs an HTTPS URL to deliver inbound messages. The daemon listens on `127.0.0.1:8787`; put a tunnel in front of it:

```bash
codex-sms-agent tunnel      # prints the commands for Tailscale Funnel or ngrok
```

Then in the Sendblue dashboard, set the receive webhook to `https://YOUR_HOST/webhook` and configure it to send your `webhookSecret` in the `sb-signing-secret` header. Put the HTTPS URL in the config as `publicUrl` so `doctor` can check it.

If you skip the tunnel, polling reconciliation still picks up messages every minute. It's just slower.

## Run

```bash
codex-sms-agent start
```

Start in **shadow** mode (the default) to confirm messages are being ingested without Codex running or replies being sent. Watch the log, text your number, and look for `message_queued`. When you're satisfied, set `"mode": "active"` in the config and restart.

To run it permanently as a user service (LaunchAgent on macOS, systemd user unit on Linux):

```bash
codex-sms-agent service install     # installs and starts; survives reboots and brew upgrades
codex-sms-agent service uninstall
```

## Conversation controls

| Command | What it does |
|---|---|
| `/clear` or `/new` | Stop any in-flight task for this conversation and start a fresh Codex thread |
| `/restart` | Stop everything, clear the thread, restart the daemon |
| `/status` | Mode, model, what it's working on, queue depth |
| `/help` | List the commands |

Only a bare command counts. `/Users/me/app.ts is broken` is a normal message. Commands are handled the moment they arrive, so they work even while a long task is running.

For everything else, just talk. "Every morning at 8 text me my calendar" creates a routine; "stop the calendar thing" deletes it.

## Configuration

`~/.config/codex-sms-agent/config.json`:

```json
{
  "sendblueApiKey": "...",
  "sendblueApiSecret": "...",
  "sendblueNumber": "+15551234567",
  "allowedPhones": ["+15557654321"],
  "webhookSecret": "generated-by-setup",
  "mode": "shadow",
  "operatorName": "Sam",
  "publicUrl": "https://your-tunnel.example.com",
  "workspace": "~/.local/share/codex-sms-agent/workspace",
  "codexModel": "gpt-5.6-sol",
  "codexReasoningEffort": "medium",
  "codexTimeoutMs": 7200000,
  "maxConcurrency": 1
}
```

| Key | Default | Notes |
|---|---|---|
| `mode` | `shadow` | `shadow` ingests only; `active` runs Codex and replies |
| `operatorName` | `the operator` | How the agent refers to you in its instructions |
| `workspace` | `~/.local/share/codex-sms-agent/workspace` | Codex's working directory. Its `AGENTS.md` holds the managed instructions plus anything you add |
| `codexModel` | `gpt-5.6-sol` | Any model your Codex login can use |
| `codexReasoningEffort` | `medium` | `minimal` … `max` |
| `codexTimeoutMs` | 2 hours | Per-turn ceiling; long tasks are fine |
| `maxConcurrency` | 1 | Parallel Codex turns across different conversations. Same conversation is always serialized |
| `pollIntervalMs` | 60000 | Reconciliation poll interval |

Every key can also be set by environment variable (`SENDBLUE_API_KEY`, `OPERATOR_NAME`, `SMS_AGENT_MODE`, `CODEX_MODEL`, …). Env wins over file.

## Teaching it your setup

Open `<workspace>/AGENTS.md`. The block between `<!-- codex-sms-agent:managed:start -->` and `…end -->` is rewritten every turn; leave it alone. Everything **below** it is yours:

```markdown
<!-- managed block above -->

# My tools
- Use `gh` for anything GitHub. My repos live in ~/code.
- For browser work use `agent-browser` with the "work" profile.
- Never touch ~/Photos.
```

Codex reads this every turn.

## How it works

1. Sendblue delivers a webhook (or the reconciler polls `GET /api/v2/messages`). Messages from non-allowlisted numbers are dropped before anything else happens.
2. The message is stored as an immutable job in SQLite. Duplicate webhooks are deduplicated by message handle.
3. A worker claims the job, downloads any attachment from Sendblue's CDN, and runs one Codex turn (new thread or resumed), with typing indicators and read receipts while it works.
4. Codex must finish with a JSON action envelope (`bubbles`, `reaction`, `media`, `carousel`). The host validates it with Zod, binds reaction targets to the triggering message, and sends via Sendblue. Malformed output is rendered as bounded plain text, never executed as actions.
5. On shutdown, in-flight turns are aborted and re-queued. On startup, anything left in `processing` by a dead process is re-queued. A stuck worker loop exits the process so the supervisor restarts it.

Logs (`~/.local/share/codex-sms-agent/logs/` under the service, stdout otherwise) contain event names, message handles, masked phone numbers, and tool type/status only. Message content, reasoning, commands, and credentials are never logged.

## Security model in one paragraph

The agent runs as your user with no sandbox, because that's what makes it useful. The trust boundary is the allowlist: only the numbers you list can reach Codex at all, and the webhook is authenticated by a shared secret compared in constant time. Sendblue credentials are kept out of Codex's environment, but a same-user process can read the config file, so treat the whole machine as reachable by anyone who can text from an allowlisted number. Web pages and documents the agent reads are untrusted; the instructions tell it to treat them as data and to confirm with you before consequential external actions, but that is a prompt-level defense, not a hard one. Run it as a separate macOS user if you want a real boundary.

## Development

```bash
npm run typecheck
npm test
npm run build
npm run check      # all three
```

No test sends a real message. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
