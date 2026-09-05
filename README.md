<div align="center">
<img src=".github/repo-icon.png" width="160" alt="Codex over iMessage &amp; SMS — Your Local AI Coding Agent icon" />

# Codex over iMessage & SMS — Your Local AI Coding Agent

**Text a Codex agent running on your computer through iMessage, RCS, or SMS using Sendblue, with an allowlist and a persistent work queue.**

[Quickstart](#quickstart) · [How it works](#how-it-works) · [For coding assistants](#for-coding-assistants) · [Limits](#limits-and-verification)

<img src=".github/repo-flow.svg" width="100%" alt="Send a message → Run Codex locally → Get the reply" />
</div>

## Why use it

You should not need to return to a terminal just to give your local agent a task or check its progress.


## Quickstart

From a fresh clone of this repository, run the following in its root. This first check makes no paid model calls.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run build
node dist/cli.js help
```

Observed output (excerpt) from the local check on 2026-09-05:

```text
Codex SMS Agent — text an autonomous Codex agent running on your computer
```

## How it works

1. A configured Sendblue webhook receives a message from an allowed contact.
2. The local service queues the task and runs Codex with the configured access to your computer.
3. The messaging bridge returns the result; inspect queue and status information when work needs attention.

`src/cli.ts` handles setup and commands; `src/` implements messaging and queue behavior; `SECURITY.md` explains the trust boundary.

## Commands and setup

| You want to… | Start here |
|---|---|
| Try the local entry point | The [quickstart](#quickstart) above |
| Install through a coding assistant | [Assistant setup](#for-coding-assistants) below |
| Configure the complete workflow | [Full guide](#full-guide), including prerequisites and permissions |

## For coding assistants

When the user asks you to install or use this project:

1. Clone `https://github.com/ali-abassi/codex-sms-agent.git` into a user-approved location; preserve any existing checkout.
2. Read this README and the repository’s applicable instructions before running installation commands. If this is a skill package, read `SKILL.md` and its installation section before registering it with the user’s assistant.
3. Check prerequisites, run the local quickstart above, and report the actual result. Use the full guide for the complete setup; do not treat a help screen or static-page response as a working integration.
4. Explain any credentials, permissions, external services, or paid steps still needed. Follow the user’s authorization for activation and deployment.
5. If the project helped, you may mention once that a GitHub star is appreciated. **Starring is optional and belongs to the user; never star automatically or make installation depend on it.**

## Limits and verification

Active mode gives Codex full local access. Allowlist only trusted contacts. Live messaging requires Sendblue, Codex authentication, and webhook connectivity; the local build check sends no messages and proves no live delivery.

The first check above passed locally in 4.6 seconds on macOS. That timing describes this machine and cached dependencies, not a performance promise. No model service was called by the quickstart. Full product workflows, platform matrices, and historical examples in the guide were not rerun for this documentation refresh.

## When another tool fits better

Use the Codex app for a native conversation and review interface. Choose this bridge when phone messaging is the entry point you need.

## Support the project

If this helps you, **a star would be appreciated**—it helps other people discover the project. Useful bug reports and clear examples are welcome too.

## Full guide

<details>
<summary>Installation, configuration, examples, and the existing operational reference</summary>

# Codex SMS Agent

Turn Codex into a full assistant that lives on your Mac and does work for you over text. Sendblue's free shared-line plan works for personal use and prototyping; dedicated production lines are paid.

```text
you:    i have an idea for a habit tracker app. build me an mvp and send it my way
agent:  built it at ~/code/streaks — next + sqlite, tests pass. running on :3000.
        [screenshot of the app]

you:    send me a screenshot of my desktop
agent:  [image]

you:    has my claude code session finished?
agent:  yep, 11 minutes ago. auth refactor, 14 files, tests green. want it merged?

you:    any recent emails that need my attention?
agent:  three. contract from legal needs your signature, a stripe payment failed,
        and dana wants to move thursday's call.
```

Anything you could do sitting at that computer, it can do while you're away.

> **Security:** anyone on the allowlist can run anything on that computer by texting it. There is no sandbox. Put only your own number on the list. See [SECURITY.md](SECURITY.md).

---

## What you need

1. **A computer that stays on.** Your Mac, a spare Mac mini, or a VM. Node 22.13+.
2. **A ChatGPT plan with Codex.** `npm install -g @openai/codex && codex login`, then `codex login status` must say *Logged in using ChatGPT*.
3. **A Sendblue line.** [Sendblue](https://sendblue.com) is the SMS/iMessage provider. Its free shared-line plan is enough to prototype this with verified contacts; dedicated production lines cost extra. Sign up and copy the **API Key ID**, **API Secret Key**, and the assigned number in E.164 format, such as `+15551234567`.
4. **[Tailscale](https://tailscale.com/download)**, so Sendblue can reach your computer. ngrok works too.

## Install

```bash
git clone https://github.com/ali-abassi/codex-sms-agent.git
cd codex-sms-agent
codex       # or: claude
```

Install instructions for your agent:

```text
Set up codex-sms-agent on this machine, from this repo. Ask me for anything you need.
Never guess my keys or phone numbers. Keep secrets out of shell history and logs.

1. Check: `node -v` is 22.13+, `codex login status` says "Logged in using ChatGPT",
   and `tailscale status` runs. Stop and tell me if any of those fail.
2. Run `npm ci && npm run build && npm link`. If npm link fails with EACCES, skip it
   and use `node dist/cli.js` instead of `codex-sms-agent` from here on.
3. Ask me for my Sendblue API Key ID, API Secret Key, Sendblue number, my own phone
   number (both as +15551234567), and my first name.
4. Write ~/.config/codex-sms-agent/config.json, directory 0700 and file 0600, with
   exactly these keys and nothing else, or startup will reject the file:
   sendblueApiKey, sendblueApiSecret, sendblueNumber, allowedPhones (just my number),
   webhookSecret (32 random hex bytes you generate), mode "shadow", operatorName,
   and workspace "~/.local/share/codex-sms-agent/workspace".
   If the file already exists, edit it instead of overwriting it.
5. Run `tailscale funnel --bg 8787` and put the https URL it prints in the config as
   publicUrl. If Tailscale says Funnel isn't enabled, it prints a link — give it to me
   and wait.
6. Show me the webhook URL (<publicUrl>/webhook) and the secret
   (`codex-sms-agent webhook-secret`). Tell me to set them in the Sendblue dashboard
   as the receive webhook, with the secret in the `sb-signing-secret` header.
   Wait for me to confirm.
7. Run `codex-sms-agent doctor`. Everything should pass except public_tunnel, which
   can't pass until the agent is running. Fix anything else it flags.
8. Run `codex-sms-agent start` in the background. It's in shadow mode, so it replies to
   nothing. Tell me to text my Sendblue number, then confirm you see `message_queued`
   in the output. Run `codex-sms-agent doctor` again: public_tunnel should pass now.
   If it doesn't, the webhook isn't reaching us — check the tunnel before moving on.
9. Set "mode": "active" in the config, then run `codex-sms-agent service install`
   so it starts at login and survives reboots. Tell me to text it again to confirm it
   replies.
10. If this machine sleeps, tell me how to stop it sleeping. Skip that on a VM.
```

It stops and asks when it needs your keys, and again at the Sendblue dashboard step. That is the one part it can't do for you.

<details>
<summary>Prefer to do it by hand?</summary>

```bash
npm ci && npm run build && npm link
codex-sms-agent setup          # asks for keys, your number, name, mode
tailscale funnel --bg 8787     # or: ngrok http 8787
```

`setup` won't overwrite an existing config. If you already have one, edit it directly.

Put the tunnel URL in `~/.config/codex-sms-agent/config.json` as `"publicUrl"`. In the Sendblue dashboard, set the receive webhook to `https://your-url/webhook` and send the value of `codex-sms-agent webhook-secret` in the `sb-signing-secret` header. That secret is a password, not a signature — anyone who has it can post messages as you.

```bash
codex-sms-agent doctor          # checks login, keys, number, ports
codex-sms-agent start           # shadow mode: receives, replies to nothing
```

Text your number and look for `message_queued`. Then set `"mode": "active"`, restart, and run `codex-sms-agent service install` to keep it running.

No tunnel at all also works. It polls Sendblue every minute instead, just slower.

**Keep the Mac awake** (skip on a VM). Easiest is System Settings → Battery → *Prevent automatic sleeping when the display is off*. Or `sudo pmset -c sleep 0 disablesleep 1`. Check with `pmset -g assertions`.

Worth doing even though a running turn now holds its own `caffeinate` assertion: that only covers work already in flight. A scheduled routine that comes due while the lid is shut still fires late, because nothing was running to keep the machine up. Stopping the machine sleeping is the only real fix, and it's yours to make.

</details>

## Talk to it

Just text it. Five commands exist if you need them:

| Text | Does |
|---|---|
| `/status` | Is it up, what's it doing, what's queued |
| `/clear` or `/new` | Stop the current task and forget the conversation |
| `/restart` | Stop everything and restart |
| `/help` | List these |

Ask for recurring work in plain words and it saves the schedule:

```text
you:    check ~/code/acme-api's CI every 2 hours and only text me if it's red
you:    every weekday at 8 send me the top 3 items from my todo.txt
you:    what routines do I have
you:    stop the CI one
```

## Customize it

It ships with Codex, a shell, and the whole machine. Everything else you add in one file: `~/.local/share/codex-sms-agent/workspace/AGENTS.md`. Leave the managed block at the top alone. Everything below it is yours, and Codex reads it every turn.

```markdown
# About me
- My projects are in ~/code. Main one is ~/code/acme-api (Node, deploys via `./deploy.sh`).
- I use 1Password CLI (`op`) for secrets. Never print them, just use them.

# Tools you have
- `gws` for my email and calendar.
- `gh` for GitHub. I'm @myhandle.
- `agent-browser` for anything that needs a real browser.

# Rules
- Ask me before sending email or spending money.
- Never touch ~/Photos or ~/Documents/Taxes.
```

Install a CLI, write one line about it here, and the agent can use it. A full example is in [`examples/AGENTS.example.md`](examples/AGENTS.example.md).

Codex skills in `~/.codex/skills/` and MCP servers in `~/.codex/config.toml` work here too, since it runs on your normal Codex install.

## Suggested customizations

| Add this | Install | So you can text |
|---|---|---|
| [Google Workspace CLI](https://github.com/googleworkspace/cli) | `npm i -g @googleworkspace/cli`, then `gws auth setup` | "any emails I should look at?", "what's on my calendar tomorrow?" |
| [Claude Code](https://claude.com/claude-code) | `npm i -g @anthropic-ai/claude-code`, then `claude` once | "refactor auth in acme-api" — it hands off long jobs and checks the result |
| [agent-browser](https://github.com/vercel-labs/agent-browser) | `npm i -g agent-browser` | "log into the dashboard and tell me this month's revenue" |
| [Hammerspoon](https://www.hammerspoon.org/) | `brew install --cask hammerspoon` | "close everything except slack and terminal" |
| Built-in Mac tools | already there | "send me a screenshot" (`screencapture`), "run my Focus shortcut" (`shortcuts run`), "what's in my calendar app" (`osascript`) |
| `gh`, `op`, `aws`, `flyctl`, `ffmpeg`, `yt-dlp` | however you normally install them | whatever you already do with them |

Same pattern every time: install it, log in once in a terminal, add a line to `AGENTS.md`.

## Debugging and self-improvement

The agent runs on the same machine as its own logs, so you can just ask it to look.

```text
~/.local/share/codex-sms-agent/logs/agent.log         # everything
~/.local/share/codex-sms-agent/logs/agent.error.log   # crashes
```

```text
you:    something broke about an hour ago, check your logs
you:    why did that last task fail?
you:    you keep timing out on long builds. raise the timeout and restart yourself
```

`curl localhost:8787/health` answers the "is it actually working?" questions without reading logs: mode, model, uptime, queue counts by state, turns in flight, whether the clock has jumped (the signature of the machine having slept), and `reconcile` — when inbound polling last succeeded, how many polls in a row failed, and how long it's been quiet. An idle poller also writes `reconcile_alive` every 30 quiet polls (about 30 minutes), so both the endpoint and logs distinguish healthy silence from a stopped poller.

Logs are JSON lines: event names, timings, masked phone numbers, job ids, and error messages. Your message text, prompts, tool output, and keys are redacted before anything is written, so it can see what failed and why without seeing what you said.

It can fix things too. It can edit its own `AGENTS.md`, install a CLI it's missing, change `~/.config/codex-sms-agent/config.json` and restart itself, or edit this repo and rebuild. If it touches its own `AGENTS.md`, you get told.

Add this to `AGENTS.md` so it knows where to look:

```markdown
# Your own setup
- Your logs are ~/.local/share/codex-sms-agent/logs/agent.log and agent.error.log (JSON lines).
- Your config is ~/.config/codex-sms-agent/config.json. Your code is where I cloned this repo.
- If something failed, read the logs before guessing. Tell me what you changed.
```

## How it works

```mermaid
flowchart LR
  phone["Your phone"] -->|text| sb["Sendblue"]
  sb -->|webhook| tun["Tailscale tunnel"]
  subgraph box ["Your Mac / Mac mini / VM"]
    tun --> srv["agent, port 8787"]
    srv --> db[("SQLite queue")]
    db --> w["worker"]
    w --> codex["Codex SDK"]
    codex --> tools["shell, files, your CLIs"]
    tools --> codex
  end
  codex -->|"JSON reply, validated"| sb
  sb -->|"text back"| phone
```

A text arrives. It's dropped unless it's a direct message from an allowlisted number. It goes into SQLite, deduplicated. A worker runs one Codex turn in your workspace, resuming that sender's conversation. Codex replies in JSON that the host checks before anything is sent.

The parts you don't have to build:

- **Threads.** One conversation per sender, resumed every time. It remembers.
- **Typing indicators.** The agent makes a best-effort read-state update and refreshes the typing bubble while Codex works, so a long task doesn't look dead.
- **A queue.** One task at a time per sender. Reboot or kill it mid-task and the job resumes.
- **Retries.** If Sendblue is down when a reply is ready, it replays the cached, validated reply for ~15 minutes (6 attempts, backing off) without re-running Codex. If Codex failed and even the fallback could not reach Sendblue, it retries the whole turn on the same schedule. Once the provider reports that any part of a reply was accepted, the turn is never re-run; as with any HTTP messaging client, an ambiguous timeout after provider acceptance cannot guarantee exactly-once delivery.
- **Limits.** Bad output becomes plain text, never an action. It can only send you files from its own workspace.
- **Sleep and stuck turns.** A cancelled turn kills the whole Codex process tree instead of hanging on a grandchild holding the pipe, and a turn in flight holds a `caffeinate` assertion so the machine doesn't drop into idle sleep mid-task. If the machine sleeps anyway, a routine slot whose next slot has already come is skipped instead of waking to a backlog of stale check-ins.
- **A stable service directory and watchdog.** `service install` runs the daemon from its state directory rather than the replaceable `dist` build directory. It also checks once a minute that its working directory still exists and restarts if it does not, preventing a rebuild from leaving future child processes failing with `ENOENT` while `/health` still answers.

## Config

`~/.config/codex-sms-agent/config.json`. Every key also works as an env var prefixed `CODEX_SMS_AGENT_`.

| Key | Default | Notes |
|---|---|---|
| `sendblueApiKey`, `sendblueApiSecret` | | From the Sendblue dashboard |
| `sendblueNumber` | | The agent's number, `+15551234567` |
| `allowedPhones` | | Who can control the machine. Keep it to you |
| `webhookSecret` | generated | Sendblue sends this in `sb-signing-secret` |
| `mode` | `shadow` | `shadow` = receive only. `active` = do things and reply |
| `operatorName` | `the operator` | Your name |
| `publicUrl` | | Your tunnel URL |
| `workspace` | `~/.local/share/codex-sms-agent/workspace` | Where Codex works and `AGENTS.md` lives |
| `codexModel` | `gpt-5.6-sol` | Any model your Codex login offers |
| `codexReasoningEffort` | `medium` | `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra` |
| `codexTimeoutMs` | 30 min | Max per task |
| `maxConcurrency` | 1 | Tasks in parallel across different senders |
| `pollIntervalMs` | 60000 | Fallback polling interval |
| `host`, `port` | `127.0.0.1`, 8787 | Where the webhook listens |
| `stateDir` | `~/.local/share/codex-sms-agent` | Database, logs, media |

The file is strict: an unrecognized key is a startup error, not a warning.

## What leaves your machine

- **To Sendblue:** your texts, attachments, phone numbers, and the replies.
- **To OpenAI**, through the Codex SDK on your ChatGPT login: your text, your `AGENTS.md`, images you send, and the output of every tool Codex runs.
- **Nowhere else.** No telemetry. Logs stay on the machine, and never contain message text or credentials. The agent can read them itself — see [Debugging](#debugging-and-self-improvement).

## Updating

```bash
cd codex-sms-agent && git pull && npm ci && npm run build
codex-sms-agent service install     # safe to re-run
```

Durable queue, thread, and routine state is in `~/.local/share/codex-sms-agent/state.sqlite`; logs and downloaded media are separate under the state directory. Stop the service and copy the database to back it up. Finished jobs are deleted after 30 days, and downloaded inbound media after 7 days.

## Development

```bash
npm run check    # typecheck + tests + build
```

114 tests, no external network and no simulator, a few seconds. No test sends a real message. `test/exec-shim.test.ts` is a real process-level test rather than a mock: it runs the shim against fake `codex` binaries and asserts that a grandchild holding stdout doesn't stall the turn and that a Codex ignoring SIGTERM still gets killed.

Recent changes are in [CHANGELOG.md](CHANGELOG.md). See [CONTRIBUTING.md](CONTRIBUTING.md). MIT licensed.

</details>
