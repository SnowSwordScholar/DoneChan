#!/usr/bin/env node
/**
 * DoneChan CLI.
 *
 * Commands:
 *   donechan hook              Consume a hook payload (stdin JSON or argv JSON)
 *                              and fire a push. Always exits 0, never blocks.
 *   donechan send [title]      Send a test notification (body from -b).
 *   donechan login <sendkey>   Write the sendkey to ~/.donechan/config.json (0600).
 *   donechan install <agent>   Print hook wiring for zcode|codex|claude.
 *   donechan check             Validate config without sending.
 */

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, openSync, writeSync, closeSync, fchmodSync, renameSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { normalize } from "./agent/normalize.js";
import { compose } from "./notification/compose.js";
import { isValidSendKey, push } from "./channel/serverchan.js";
import { loadConfig, userConfigPath } from "./config/load.js";
import { stageHandoff, spawnDetached, readHandoff, sweepStaleStaging, shellQuoteWin, shellQuotePosix } from "./handoff.js";

const VERSION = "0.1.0";

function out(msg: string): void {
  process.stdout.write(`${msg}\n`);
}

function err(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

/**
 * Shell-quote a value for the target platform. Used only when generating
 * config snippets for agents whose command hooks run through a shell.
 */
function shellQuote(value: string, platform: "win" | "posix"): string {
  return platform === "win" ? shellQuoteWin(value) : shellQuotePosix(value);
}

function entryPath(): string {
  return process.argv[1]!;
}

async function readStdin(timeoutMs = 3000): Promise<string> {
  if (process.stdin.isTTY) return "";
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let done = false;
    const finish = (value: string) => {
      if (!done) {
        done = true;
        resolve(value);
      }
    };
    const timer = setTimeout(() => finish(Buffer.concat(chunks).toString("utf8")), timeoutMs);
    process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on("end", () => {
      clearTimeout(timer);
      finish(Buffer.concat(chunks).toString("utf8"));
    });
    process.stdin.on("error", () => {
      clearTimeout(timer);
      finish(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

function parseJsonLoose(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/** `donechan hook [raw-json]` — the universal hook entry point. */
async function cmdHook(argvJson?: string): Promise<number> {
  // Codex legacy notify passes the JSON as the final argv argument; everyone
  // else pipes it through stdin.
  const raw = argvJson ?? (await readStdin());
  const event = normalize(parseJsonLoose(raw));
  if (!event) {
    // Unrecognized payload: stay silent, never break the agent session.
    return 0;
  }
  const config = loadConfig(event.cwd);
  if (!config) {
    err("donechan: no valid sendkey configured (DONECHAN_SENDKEY or ~/.donechan/config.json); notification skipped");
    return 0;
  }

  const notification = compose(event);
  const title = config.titlePrefix ? `${config.titlePrefix} ${notification.title}` : notification.title;
  const payload = {
    title,
    desp: notification.body,
    ...(notification.short ? { short: notification.short } : {}),
    ...(config.tags || notification.tags ? { tags: config.tags ?? notification.tags } : {}),
  };

  // Hand the payload to the detached worker via a temp file: Windows argv has
  // a hard length limit and marker bodies are unbounded, so argv could drop
  // notifications silently.
  let handoff: Awaited<ReturnType<typeof stageHandoff>> | null = null;
  try {
    handoff = await stageHandoff(JSON.stringify(payload));
    spawnDetached(entryPath(), handoff.file, event.cwd);
  } catch (e) {
    err(`donechan: failed to stage payload: ${e instanceof Error ? e.message : e}`);
    // If the worker never got a chance to run, clean the staging dir here so
    // notification content does not linger in the temp filesystem.
    if (handoff) await handoff.cleanup();
  }
  // Sweep staging dirs orphaned by crashed/killed runs (24h age guard); do it
  // here, not in the worker, so cleanup does not depend on a notification.
  void sweepStaleStaging();
  return 0;
}

/** `donechan __send --payload-file <file>` — internal detached worker. Do not call by hand. */
async function cmdSendInternal(args: string[]): Promise<number> {
  const fileIndex = args.indexOf("--payload-file");
  if (fileIndex < 0 || !args[fileIndex + 1]) return 0;
  const staged = args[fileIndex + 1]!;
  const config = loadConfig(process.cwd());
  if (!config) {
    // No key configured: consume the staging file anyway so notification
    // content never lingers in the temp filesystem.
    await readHandoff(staged).catch(() => {});
    return 0;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(await readHandoff(staged));
  } catch {
    return 0;
  }
  await push(config.sendKey, payload as Parameters<typeof push>[1]);
  return 0;
}

/** `donechan send [title] [-b body]` — user-facing connectivity test. */
async function cmdSend(args: string[]): Promise<number> {
  const config = loadConfig(process.cwd());
  if (!config) {
    err("donechan: no valid sendkey. Set DONECHAN_SENDKEY or write ~/.donechan/config.json:");
    err(`  {"sendkey": "sctp<uid>t<secret>"}`);
    return 1;
  }
  const bodyIndex = args.indexOf("-b");
  const body = bodyIndex >= 0 ? (args[bodyIndex + 1] ?? "") : "";
  const rest = args.filter((a, i) => a !== "-b" && i !== bodyIndex + 1);
  const title = rest.join(" ") || "DoneChan 测试通知";
  const result = await push(config.sendKey, {
    title,
    desp: body || "如果你收到这条消息，说明 DoneChan 工作正常 🎉",
  });
  if (result.ok) {
    out(`✅ ${result.message}${result.pushId ? ` (pushid ${result.pushId})` : ""}`);
    return 0;
  }
  err(`❌ ${result.message}`);
  return 1;
}

/** `donechan check` — validate config, print what would happen. */
function cmdCheck(): number {
  const config = loadConfig(process.cwd());
  if (!config) {
    err("❌ no valid sendkey (DONECHAN_SENDKEY env, ~/.donechan/config.json, or .donechan/config.json)");
    return 1;
  }
  out("✅ sendkey format looks valid");
  if (config.titlePrefix) out(`   title prefix: ${config.titlePrefix}`);
  if (config.tags) out(`   tags: ${config.tags}`);
  out('try: donechan send "hello"');
  return 0;
}

const ZCODE_HOOK = {
  type: "process",
  command: "node",
  args: ["<donechan-entry>", "hook"],
  timeoutMs: 8000,
  statusMessage: "DoneChan：推送完成通知",
};

const CODEX_HOOK = {
  type: "command",
  command: "donechan hook",
  commandWindows: "node <donechan-entry-quoted> hook",
  timeout: 15,
  async: true,
  statusMessage: "DoneChan: pushing done notification",
};

function cmdInstall(agent: string): number {
  const entry = entryPath();
  switch (agent) {
    case "zcode": {
      const hook = JSON.parse(JSON.stringify(ZCODE_HOOK));
      hook.args = [entry, "hook"];
      out("// 合并进 ~/.zcode/cli/config.json（用户级）或 <repo>/.zcode/config.json（项目级）：");
      out(JSON.stringify({ hooks: { enabled: true, events: { Stop: [{ hooks: [hook] }] } } }, null, 2));
      break;
    }
    case "codex": {
      const hook = JSON.parse(JSON.stringify(CODEX_HOOK));
      // Codex command hooks run through a shell; quote the entry path so
      // spaces and shell metacharacters cannot break or inject the command.
      hook.command = `node ${shellQuote(entry, "posix")} hook`;
      hook.commandWindows = `node ${shellQuote(entry, "win")} hook`;
      out("// 写入 ~/.codex/hooks.json：");
      out(JSON.stringify({ hooks: { Stop: [{ hooks: [hook] }] } }, null, 2));
      out("// 注意：Codex 首次加载该 hook 会提示信任确认。");
      break;
    }
    case "claude": {
      out("// 合并进 ~/.claude/settings.json：");
      out(
        JSON.stringify(
          {
            hooks: {
              Stop: [
                {
                  hooks: [
                    {
                      type: "command",
                      // Claude command hooks run through the OS shell; pick
                      // quoting per platform so Windows cmd.exe gets double
                      // quotes instead of POSIX single quotes it ignores.
                      command: `node ${shellQuote(entry, "posix")} hook`,
                      commandWindows: `node ${shellQuote(entry, "win")} hook`,
                      async: true,
                      timeout: 15,
                    },
                  ],
                },
              ],
            },
          },
          null,
          2,
        ),
      );
      break;
    }
    default:
      err(`unknown agent "${agent}" (supported: zcode | codex | claude)`);
      return 1;
  }
  out("");
  out(`// 并确保已配置 sendkey：{"sendkey": "..."} → ${userConfigPath()}`);
  return 0;
}

/**
 * Atomically replace a file: write to a temp sibling, fsync + chmod, rename
 * over the target. Keeps permissions tight (0600) since the file holds the
 * SendKey, and never leaves a truncated config on crash.
 */
function atomicWritePrivate(path: string, content: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeSync(fd, content);
      if (process.platform !== "win32") fchmodSync(fd, 0o600);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    throw e;
  }
}

/** `donechan login <sendkey>` — persist the sendkey safely. */
function cmdLogin(sendKey: string): number {
  if (!isValidSendKey(sendKey)) {
    err("invalid sendkey format (expected sctp<uid>t<secret> or SCT...)");
    return 1;
  }
  const path = userConfigPath();
  let existing: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        existing = parsed as Record<string, unknown>;
      } else {
        throw new Error("config root is not an object");
      }
    } catch {
      // Preserve the unreadable file and fail loudly rather than silently
      // reporting success after discarding user config.
      const backup = `${path}.corrupt-${Date.now()}`;
      try {
        renameSync(path, backup);
        err(`existing config is not valid JSON; moved to ${backup}`);
      } catch {
        err(`existing config at ${path} is not valid JSON and could not be backed up`);
      }
      err("fix or delete that file, then run donechan login again");
      return 1;
    }
  }
  mkdirSync(dirname(path), { recursive: true });
  existing.sendkey = sendKey;
  atomicWritePrivate(path, JSON.stringify(existing, null, 2));
  out(`✅ sendkey written to ${path} (permissions 0600 on unix)`);
  return 0;
}

function usage(): number {
  out(`DoneChan v${VERSION} — AI 任务完成通知（Server酱³）

用法:
  donechan hook [json]     hook 统一入口（stdin 或 argv JSON），绝不阻塞
  donechan send [标题]     发送测试通知（-b 正文）
  donechan check           校验配置
  donechan install <agent> 打印 agent 接入配置（zcode | codex | claude）
  donechan login <sendkey> 把 sendkey 写入 ~/.donechan/config.json
  donechan --version       版本号

文档: https://github.com/SnowSwordScholar/DoneChan`);
  return 0;
}

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case undefined:
    case "--help":
    case "-h":
    case "help":
      return usage();
    case "--version":
    case "-v":
      out(`donechan v${VERSION}`);
      return 0;
    case "hook":
      return cmdHook(rest[0]);
    case "__send":
      return cmdSendInternal(rest);
    case "send":
      return cmdSend(rest);
    case "check":
      return cmdCheck();
    case "install":
      return rest[0] ? cmdInstall(rest[0]) : (err("usage: donechan install <zcode|codex|claude>"), 1);
    case "login":
      return rest[0] ? cmdLogin(rest[0]) : (err("usage: donechan login <sendkey>"), 1);
    default:
      err(`unknown command: ${cmd}`);
      return usage();
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    err(`donechan: ${e instanceof Error ? e.message : e}`);
    process.exit(0); // never break the agent session
  },
);
