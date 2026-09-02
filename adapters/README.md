# DoneChan adapters

Per-agent wiring for the shared core. Each file is a **config-only adapter** —
no code, just the hook declaration the agent understands.

| File | Target | Where it goes |
|---|---|---|
| `zcode/config.user.json` | ZCode | merge into `~/.zcode/cli/config.json` |
| `zcode/config.project.json` | ZCode | merge into `<repo>/.zcode/config.json` |
| `zcode/plugin/` | ZCode | a distributable ZCode plugin (hooks auto-enabled) |
| `codex/hooks.json` | Codex | copy to `~/.codex/hooks.json` (or merge into `.codex/hooks.json`) |
| `codex/notify.toml` | Codex legacy | `notify = [...]` inside `~/.codex/config.toml` |
| `claude/settings.json` | Claude Code | merge into `~/.claude/settings.json` |

Regenerate with real absolute paths via:

```bash
donechan install zcode
donechan install codex
donechan install claude
```

## Path placeholders

- `<donechan-entry>` — absolute path to `dist/cli.js` (or the global npm shim
  `donechan` if installed globally).

## Agent-specific notes

- **ZCode** runs hooks synchronously; DoneChan spawns a detached child process
  and exits immediately, so the session is never blocked. Keep `timeoutMs` at
  ~8s as a safety net.
- **Codex** supports true background hooks (`"async": true`) and a
  `commandWindows` override; it also asks the user to trust new hooks on first
  load — that prompt is expected.
- **Claude Code** supports `"async": true` on command hooks.
- **Codex legacy notify** receives the payload as the final argv argument
  instead of stdin; `donechan hook` detects this automatically.
