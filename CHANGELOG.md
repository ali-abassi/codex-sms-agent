# Changelog

All notable changes to this project are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/); versions follow SemVer.

## [Unreleased]

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
