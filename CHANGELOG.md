# Changelog

All notable changes to DoneChan will be documented in this file.
Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Interactive multi-agent installer: `donechan install <zcode|codex|claude|opencode|all>`
  preflights the SendKey, detects existing DoneChan wiring, shows a plan, and
  merges the config after confirmation; `--print` keeps the plain preview
  mode. Piped confirmations now work across agents (`install all` no longer
  stalls after the first one).
- Marker protocol v2: a hidden `[](donechan://<base64url>)` link form for
  Codex (which renders HTML comments visibly), tolerance for renderers that
  escape `<!--` as `\<!--`, and recovery of the final reply from Claude Code's
  `transcript_path` so markers work when the Stop payload carries no text.
- OpenCode support via a plugin: OpenCode has no Stop hook, so the plugin
  listens to `session.idle` and caches the last assistant reply from
  `message.updated`, then pipes it into `donechan hook`.
- `donechan config` CLI to list/read/write `sendkey`, `title_prefix`, `tags`,
  and `marker_tags_enabled` with atomic writes.

### Changed

- The push transport now forces IPv4: ServerChan³'s backend rejects requests
  arriving over IPv6 ("Data too long for column 'ip'").

### Fixed

- `donechan install codex` silently dropped the DoneChan hook whenever
  `~/.codex/hooks.json` already existed; Stop groups are now merged directly
  under `hooks` without the Codex-incompatible `enabled: true` flag.
- OpenCode notifications were mislabeled as Claude Code; they now carry the
  `OpenCode` tag.

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
