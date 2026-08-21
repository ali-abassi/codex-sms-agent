# Changelog

All notable changes to this project are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/); versions follow SemVer.

## [Unreleased]

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
