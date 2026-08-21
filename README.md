# Codex SMS Agent

**A Codex agent that lives on your Mac. Text it like a personal assistant.**

It runs on your own computer, gets your texts over iMessage/SMS, and does the work: runs commands, writes code, fixes things, moves files, opens apps, checks on stuff, and texts you back. Anything you could do sitting at your Mac, it can do while you're out.

```text
you:    is the deploy done? restart nginx if so
agent:  yep, landed at 14:02. nginx restarted, /health is 200.

you:    make me a python script that renames everything in ~/Downloads by date
agent:  done, ~/bin/rename_by_date.py. dry-run by default, --apply to commit.

you:    every weekday at 8 text me what's on my calendar
agent:  set. first one tomorrow 8am.
```

- Built on the official `@openai/codex-sdk`, using your existing ChatGPT plan (`codex login`). No API key.
- Remembers context across texts, so you can say "now do the same for staging".
- Direct messages only. Group chats are ignored on purpose.
- Send it photos and screenshots. It sends back text, images, files, reactions.
- Ships **barebones**: Codex + a shell. You add the skills and tools you want (see [Customize](#customize-it)).

> **Security, plainly:** whoever is on the allowlist has full, unsandboxed control of your Mac over text. Only allowlist yourself. Use a dedicated Sendblue number. Details in [SECURITY.md](SECURITY.md).

---

## Setup (about 10 minutes)

### 1. Codex CLI, logged in

You need a ChatGPT plan with Codex access (Plus, Pro, Team, etc).

```bash
npm install -g @openai/codex
codex login
codex login status     # must say: Logged in using ChatGPT
```

### 2. A Sendblue number and API keys

[Sendblue](https://sendblue.com) gives you a phone number that can send and receive iMessage/SMS through an API.

1. Sign up at [sendblue.com](https://sendblue.com) and get a number. To try it free first, the sandbox works:
   ```bash
   npx -y @sendblue/cli@latest sandbox init
   ```
2. In the Sendblue dashboard, go to **API Keys** and copy the **API Key ID** and **API Secret Key**. (Or from the CLI: `sendblue login`, then `sendblue show-keys` and `sendblue lines`.)
3. Note your Sendblue number in E.164 format, like `+15551234567`.

### 3. Install and configure

```bash
git clone https://github.com/ali-abassi/codex-sms-agent.git
cd codex-sms-agent
npm ci && npm run build && npm link
codex-sms-agent setup
```

`setup` asks for:
- your Sendblue API key and secret
- your Sendblue number
- **your** phone number(s), the ones allowed to control the Mac
- your first name (so it knows what to call you)

It writes everything to `~/.config/codex-sms-agent/config.json` (mode 0600). Then:

```bash
codex-sms-agent doctor     # checks Codex login, Sendblue keys, the number, ports
```

### 4. Let Sendblue reach your Mac

Sendblue delivers incoming texts to an HTTPS URL. The agent listens on `localhost:8787`, so you need a tunnel. Easiest is Tailscale Funnel if you have Tailscale; otherwise ngrok:

```bash
# Tailscale
tailscale funnel --bg 8787
# or ngrok
ngrok http 8787
```

Either gives you an `https://...` URL. Then:

1. Put it in the config: `"publicUrl": "https://your-url"`
2. In the Sendblue dashboard, set your **receive webhook** to `https://your-url/webhook` and have it send your `webhookSecret` (from the config file) in the `sb-signing-secret` header.

No tunnel? It still works. The agent polls Sendblue every minute as a fallback. Just slower.

### 5. Run it

```bash
codex-sms-agent start
```

It starts in **shadow** mode: it receives texts but doesn't run Codex or reply. Text your Sendblue number and watch for `message_queued` in the output. If you see it, the pipe works.

Now flip it on. In `~/.config/codex-sms-agent/config.json` set `"mode": "active"`, restart, and text it something.

### 6. Keep it running

```bash
codex-sms-agent service install    # starts at login, restarts on crash, survives reboots
```

Logs go to `~/.local/share/codex-sms-agent/logs/agent.log`. `codex-sms-agent service uninstall` removes it.

---

## Talk to it

Just text. No syntax. A few commands exist for when you need them:

| Text | Does |
|---|---|
| `/status` | Is it up, what's it doing, what's queued |
| `/clear` | Stop the current task and forget the conversation so far |
| `/restart` | Stop everything and restart the agent |
| `/help` | List these |

"Check the build every 2 hours", "stop checking the build", "what routines do I have" all work in plain words.

---

## Customize it

Out of the box the agent has Codex, a shell, and your Mac. That's already a lot. To make it *yours*, there are three layers, and none of them require touching this repo's code.

### Tell it about your world: `AGENTS.md`

The agent's working directory is `~/.local/share/codex-sms-agent/workspace/`. Its `AGENTS.md` has a managed block at the top (leave that alone, it's rewritten every turn). **Everything below it is yours** and Codex reads it every single turn:

```markdown
<!-- managed block ends above this line -->

# About me
- My projects are in ~/code. Main one is ~/code/acme-api (Node, deploys via `./deploy.sh`).
- I use 1Password CLI (`op`) for secrets. Never print them, just use them.

# Tools you have
- `agent-browser` for anything on the web that needs a real browser. Use the "work" profile.
- `gh` for GitHub. I'm @myhandle.
- `shortcuts run "Focus Mode"` toggles my focus mode.

# Rules
- Ask me before sending email or spending money.
- Never touch ~/Photos or ~/Documents/Taxes.
```

This is where most of the personality and capability lives. Install a CLI, write one line about it, and the agent can use it.

### Give it tools

Anything on your `PATH` is fair game. Some that pair well:

| Want it to... | Install | Then say in AGENTS.md |
|---|---|---|
| Browse the web with a real browser | [`agent-browser`](https://github.com/vercel-labs/agent-browser) or Playwright | "Use `agent-browser` for web tasks" |
| Work with GitHub | `brew install gh`, `gh auth login` | "Use `gh` for GitHub" |
| Drive Mac windows and apps | [Hammerspoon](https://www.hammerspoon.org/) + its `hs` CLI | "Use `hs` for window management" |
| Run Shortcuts | built in | "`shortcuts run <name>`" |
| Control apps via AppleScript | built in (`osascript`) | nothing needed |

The agent's `PATH` includes `~/.local/bin`, `/opt/homebrew/bin`, and `/usr/local/bin`.

### Codex skills and MCP servers

The agent runs through your normal Codex install, so whatever you've set up for Codex applies here too:

- **Skills** in `~/.codex/skills/` are available to it.
- **MCP servers** configured in `~/.codex/config.toml` are available to it.

If you've already taught Codex how to work on your machine, the SMS agent inherits all of it.

---

## Config reference

`~/.config/codex-sms-agent/config.json`. Every key can also be an environment variable (`SENDBLUE_API_KEY`, `OPERATOR_NAME`, `SMS_AGENT_MODE`, `CODEX_MODEL`...); env wins.

| Key | Default | Notes |
|---|---|---|
| `sendblueApiKey`, `sendblueApiSecret` | | From the Sendblue dashboard |
| `sendblueNumber` | | Your Sendblue line, E.164 |
| `allowedPhones` | | Who can control the Mac. Keep it to you |
| `webhookSecret` | generated | Sendblue sends this in `sb-signing-secret` |
| `mode` | `shadow` | `shadow` = receive only. `active` = do things and reply |
| `operatorName` | `the operator` | Your name, as the agent refers to you |
| `publicUrl` | | Your tunnel URL, for `doctor` |
| `workspace` | `~/.local/share/codex-sms-agent/workspace` | Where Codex works and where `AGENTS.md` lives |
| `codexModel` | `gpt-5.6-sol` | Any model your Codex login offers |
| `codexReasoningEffort` | `medium` | `minimal` to `max` |
| `codexTimeoutMs` | 2 hours | Max per task. Long tasks are fine |
| `maxConcurrency` | 1 | Tasks in parallel across *different* senders. One sender is always sequential |
| `pollIntervalMs` | 60000 | Fallback polling interval |

---

## How it works, briefly

Text arrives (webhook or poll) → dropped unless it's a direct message from an allowlisted number → stored in SQLite, deduplicated → a worker runs one Codex turn in your workspace, resuming that sender's thread → Codex returns a JSON envelope (up to 4 text bubbles, optional reaction/media/carousel) → the host validates it and sends via Sendblue.

If the Mac reboots mid-task, the task is re-queued. If the agent is stopped mid-task, same. If Codex produces garbage, you get bounded plain text, never an executed action. Logs contain event names and masked phone numbers, never message content or credentials.

## Development

```bash
npm run check    # typecheck + tests + build
```

No test sends a real message. See [CONTRIBUTING.md](CONTRIBUTING.md). MIT licensed.
