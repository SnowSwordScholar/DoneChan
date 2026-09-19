# Changelog

All notable changes to DoneChan will be documented in this file.
Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- **DSH (DeepSeek Harness) support** via a native plugin
  (`adapters/dsh/plugin/`), installed by `donechan install dsh` into
  `$DSH_HOME/profiles/<profile>/node_modules/donechan-dsh` and mounted from the
  profile's `cordis.patch.yml`. The plugin reads the live session through the
  harness API, so DSH completion pushes carry the assistant's own reply. It also
  pushes the question verbatim when the agent parks on the user
  (`ask_user_question`, `exit_plan_mode`).
  - `donechan hook --wait` / an `--agent dsh` label keep the send worker alive
    until its push finishes: DSH reaps a hook's process tree on exit, which
    silently killed the detached worker partway through its push.
  - Installing retires the superseded `dsh-hooks-claude-code` bridge wiring
    (patch entry and its `hooks.json`) so one event cannot push twice.
- `donechan uninstall <agent|all>` removes the marker-protocol skill an older
  install left behind (hook and plugin wiring is untouched).
- `marker_enabled` config key (default `false`).

### Changed

- **The marker protocol is now opt-in.** Notifications carry the assistant's own
  reply by default (title = first line, body = the reply, which ServerChan
  renders as Markdown), so the model writes nothing extra and spends no tokens.
  Enable it with `donechan install <agent> --skill` **and**
  `donechan config marker_enabled true`.
- `donechan install` no longer installs the marker skill unless `--skill` is
  passed, and warns when an older install left one behind.
- Template fallback still strips marker-shaped text unconditionally, so a stray
  marker never reaches the phone whether or not the protocol is on.

## [0.2.1] - 2026-09-06

### Fixed

- Marker hardening, driven by a live incident where a misplaced marker's raw
  text reached the phone via the template fallback:
  - `extractMarker` scans the last 3 non-empty lines (still end-anchored),
    so a short sign-off after the marker no longer disables it; a line must
    now BE the marker (`^` anchor added), so prose that merely ends with an
    example never fires.
  - Template fallback strips marker-shaped text before building the
    notification — well-formed markers, Codex hidden links, truncated
    markers with no closing `}-->`, and `"}-->` residue from broken nested
    JSON. A misplaced marker can no longer leak raw JSON to the phone.
- `cap`/`truncate` cut on code-point boundaries: field caps and title
  truncation can no longer split a surrogate pair into a lone surrogate
  (rendered as U+FFFD on the phone).

### Changed

- `src/cli.ts` `VERSION` constant now tracks package.json (was left at
  0.1.0 after the 0.2.0 release).
- SKILL docs (both variants) state the protocol rules explicitly: the
  marker must be the last line, alone, with no text after it, never inside
  a code block.

### Added

- 10 new regression tests (69 → 79), including the live-incident shape,
  the tail-window edges, and code-point boundary caps.

## [0.2.0] - 2026-09-06

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
- `repository`, `homepage`, `bugs`, and `author` in package.json, so the npm
  page links back to GitHub.

### Changed

- The push transport now forces IPv4: ServerChan³'s backend rejects requests
  arriving over IPv6 ("Data too long for column 'ip'").
- package.json description and keywords now mention OpenCode.

### Fixed

- `donechan install codex` silently dropped the DoneChan hook whenever
  `~/.codex/hooks.json` already existed; Stop groups are now merged directly
  under `hooks` without the Codex-incompatible `enabled: true` flag.
- OpenCode notifications were mislabeled as Claude Code; they now carry the
  `OpenCode` tag.
- The OpenCode plugin now spawns `donechan hook` via `node:child_process`
  instead of Bun's `$` shell: the desktop app runs its server on Node where
  `$` is undefined, so the old shell template threw on every event it
  handled and the error was swallowed by the plugin's catch-all.

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
