# Changelog

All notable changes to DoneChan will be documented in this file.
Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.1.0] - 2026-09-02

### Added

- Unified hook entry (`donechan hook`) that consumes stdin JSON from
  ZCode / Codex hooks / Claude Code and argv JSON from Codex legacy notify,
  with agent auto-detection from payload fingerprints.
- Marker protocol: AI appends `<!--donechan: {...}-->` to its final reply to
  define the notification title/body/tags; parsed and pushed verbatim.
- Template fallback (`✅ <first line of reply>`) when no marker is present.
- ServerChan³ channel with SC3/Turbo SendKey routing (`sctp…` →
  `push.ft07.com`, `SCT…` → `sctapi.ftqq.com`), JSON POST, 5s timeout,
  client-side pacing, and SendKey-safe error messages.
- Fire-and-forget execution: the hook entry spawns a detached worker so
  synchronous-hook agents (ZCode) are never blocked.
- Config discovery: `DONECHAN_SENDKEY` env > `.donechan/config.json` (project)
  > `~/.donechan/config.json` (user).
- `donechan send` connectivity test, `donechan check` config validation,
  `donechan install <zcode|codex|claude>` config generators,
  `donechan login <sendkey>`.
- Config-only adapters (`adapters/`), a distributable ZCode plugin bundle
  (`adapters/zcode/plugin/`), and an agent skill teaching the marker protocol
  (`skills/donechan-notify/`).
- CI matrix (ubuntu/windows/macos × Node 18/20/22) with a hook-exit-code smoke
  test.
