# Security Policy

## Reporting a vulnerability

Please report security issues privately via GitHub Security Advisories
("Report a vulnerability" on the Security tab) rather than a public issue.
You can expect a response within 7 days.

## Threat model & design decisions

DoneChan's hook process receives agent session payloads via stdin/argv and
sends one HTTP request to ServerChan³. The security posture:

- **SendKey handling** — the key is read from `DONECHAN_SENDKEY`,
  `.donechan/config.json` (project), or `~/.donechan/config.json` (user). It is
  never logged, echoed, or embedded in error messages. It is transmitted only
  to the ServerChan endpoint (`*.push.ft07.com` / `sctapi.ftqq.com`).
- **Notification content** — derived from the agent's final reply. Do not put
  secrets in marker protocol content; the notification leaves your machine.
- **Process model** — the hook entry spawns a detached child and exits. The
  child makes the HTTP call with a 5s timeout and no retry loop.
- **No telemetry.** DoneChan collects and sends nothing anywhere else.

## Known considerations

- Anyone with write access to your agent's hook configuration can change where
  notifications go. On Codex, unmanaged hooks require a one-time trust
  confirmation — that prompt is intentional; read what you approve.
- A project-level `.donechan/config.json` can set a `sendkey`. Your personal
  `DONECHAN_SENDKEY` environment variable always overrides it, so review
  third-party repos before letting their project config push through your key.

## Scope

The ServerChan³ service itself (availability, key security on their side) is
out of scope; see https://sc3.ft07.com for their policies.
