# Changelog

All notable changes to this project are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/); versions follow SemVer.

## [Unreleased]

### Fixed
- **The service no longer runs from the build output directory.** `npm run build` starts with
  `rm -rf dist`, so building while the service ran unlinked the daemon's working directory; on
  macOS a process whose cwd has been deleted cannot spawn anything, and every `codex exec` died
  instantly with `Error: No such file or directory (os error 2)`. The process still answered
  `/health` and held its port, so it silently replied to every message with the fallback text
  for hours. `WorkingDirectory` is now the state directory; re-run `service install` to repair
  an existing install.
- **Cancelled Codex turns can no longer hang forever.** The SDK sends SIGTERM to the Codex
  binary alone and then reads its stdout to EOF, so a grandchild holding the pipe kept the turn
  pending and the sender's thread claimed. A supervising shim now ends the stream when Codex
  exits and kills the whole process tree on cancellation, and the runner stops waiting after a
  bounded grace.
- **A partially delivered reply is never re-sent.** A transient provider error after some
  bubbles had gone out could re-run the turn and text them again.
- Inbound attachments served from Sendblue's `storage.googleapis.com/inbound-file-store` bucket
  are accepted instead of rejected, and typed by extension when served as `octet-stream`.
- Sendblue errors name the endpoint only; the query string carried the account's own number
  URL-encoded past the log scrubber.

### Added
- `working_directory_missing` watchdog: probes `process.cwd()` once a minute and exits so the
  supervisor restarts, turning a permanent silent outage into a ten-second restart.
- Codex turns run under a supervising launcher that also holds a macOS `caffeinate -i`
  assertion, so the machine does not drop into idle sleep mid-turn.
- Routine slots are skipped when the next slot has already come or the previous run is still
  open, and a queued routine run is dropped once it is past its own interval
  (`routine_slot_skipped`, `routine_run_skipped_stale`) — a sleeping machine no longer wakes to
  a backlog of stale check-ins.
- `clock_jump_detected` when a timer tick arrives more than a minute late (the signature of the
  machine having slept), plus queue counts, in-flight turns, and clock-jump history on `/health`.
- `unhandledRejection` / `uncaughtException` are logged as JSON before a non-zero exit.
- `doctor` checks free disk space; a full volume makes the SQLite queue reject writes.

## [0.2.0] - 2026-08-21

### Added
- Clock-aligned routines: `--at HH:MM` and `--days weekdays|mon,wed|...` for daily/weekly intervals (local time)
- Delivery retry: a finished turn's envelope is cached and re-sent with backoff during Sendblue outages (6 attempts, ~15 min) instead of re-running Codex or texting a "snag"
- `codex-sms-agent status` CLI (daemon reachability, queue counts, routines, last successful turn)
- Tripwire: if a turn changes the operator section of `AGENTS.md`, the operator is texted and a warning is logged
- `CODEX_SMS_AGENT_*` environment variable names (old short names still accepted; bare `PORT`/`HOST` no longer read)
- Schema versioning (`PRAGMA user_version`) with in-place migrations

### Changed
- Prompt mentions macOS tools only on macOS
- Removed legacy `text`/`replyTo` envelope fields from the host schema (the SDK schema never allowed them); `text` is still tolerated on input
- One E.164 definition shared by config, setup, client, and logger

## [0.1.0] - 2026-08-21

First public release.

- Sendblue webhook + polling ingestion, SQLite queue with dedup and per-sender serialization
- One persistent Codex thread per sender, image inputs, text/reaction/media/carousel replies
- Control commands (`/clear`, `/restart`, `/status`, `/help`) handled out of band
- Interval routines
- Crash-safe lifecycle: abortable turns, re-queue on shutdown, recovery on startup, exit on stuck worker
- Local media uploads confined to the workspace and media directory
- Automatic pruning of finished jobs (30 days) and attachments (7 days)
- LaunchAgent and systemd user-unit installers, setup wizard, doctor
