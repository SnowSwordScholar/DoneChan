# Contributing to DoneChan

Thanks for your interest! DoneChan is a small, focused tool: it listens for
"task done" hooks from AI coding agents and pushes a notification through
ServerChan³. The AI defines the notification content via a marker protocol.

## Development setup

```bash
git clone https://github.com/SnowSwordScholar/DoneChan
cd DoneChan
npm install
npm run build   # tsc -> dist/
npm test        # vitest
```

## Project layout

```
src/
  agent/         hook payload normalization (ZCode / Codex / Codex legacy / Claude)
  notification/  marker protocol + template fallback + compose
  channel/       ServerChan³ push (SC3 + Turbo routing)
  config/        sendkey discovery (env > project > user)
  cli.ts         command surface (hook / send / check / install / login)
adapters/        per-agent config snippets (no code)
skills/          agent skill teaching the marker protocol
tests/           vitest unit tests
```

## Ground rules

1. **Never block the agent.** `donechan hook` must always exit 0 and exit fast.
   Errors go to stderr and are swallowed; pushes happen in a detached process.
2. **Never log or echo the SendKey.** Error paths must not include it. The
   server response `message` field is the only external text we surface.
3. **Adapter changes are config-only.** Agent wiring lives in `adapters/` as
   JSON/TOML snippets; behavior changes belong in `src/`.
4. **Schema fidelity.** `src/agent/normalize.ts` mirrors the verified stdin
   payloads of each agent (see `adapters/README.md`). If an agent changes its
   hook schema, update the normalization and its tests together.

## Commit style

Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`) keep the
changelog greppable.

## Testing

- Unit tests live in `tests/` and must pass on all three major OSes (CI runs
  the matrix).
- For an end-to-end check with a real key: `donechan login <sendkey>` then
  `donechan send "hello"`.

## Reporting issues

Include the agent (ZCode / Codex / Claude Code), its version, your OS, and the
hook payload (with the SendKey redacted) that triggered the problem.
