# Contributing

Thanks for helping. Small, focused PRs are easiest to review.

## Setup

```bash
npm ci
npm run check          # typecheck + tests + build
npx vitest run test/worker.test.ts   # one file
```

Node 22.13+ (uses `node:sqlite`). No test sends a real message or needs Sendblue or Codex credentials.

## Layout

- `src/domain/` pure types and helpers
- `src/sendblue/` transport: HTTP client, payload normalization, messaging port
- `src/codex/` the Codex SDK adapter, the managed instructions, the action envelope schema
- `src/state/` SQLite store (queue, threads, routines, metadata)
- `src/ingest.ts`, `src/worker.ts`, `src/reconcile.ts`, `src/daemon.ts` orchestration
- `src/http/`, `src/cli.ts`, `src/setup.ts`, `src/doctor.ts`, `src/service.ts` edges

## Rules

- Never commit credentials, real phone numbers, message content, SQLite files, logs, or downloaded media. Tests use `+1555…` numbers.
- Anything that changes what Codex is allowed to do, what the host validates, or who can reach the daemon needs a line in SECURITY.md and a test.
- Keep the managed instructions in `src/codex/prompt.ts` generic. Personal tooling belongs in the operator's own `AGENTS.md` section.
- Add a CHANGELOG entry under *Unreleased*.
