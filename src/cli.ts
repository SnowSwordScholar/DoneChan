#!/usr/bin/env node
/**
 * DoneChan CLI.
 *
 * Commands:
 *   donechan hook              Consume a hook payload (stdin JSON or argv JSON)
 *                              and fire a push. Always exits 0, never blocks.
 *   donechan send [title]      Send a test notification (body from stdin or -b).
 *   donechan install <agent>   Print/apply hook wiring for zcode|codex|claude.
 *   donechan check             Validate config without sending.
 */

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { normalize } from "./agent/normalize.js";
import { compose } from "./notification/compose.js";
import { isValidSendKey, push } from "./channel/serverchan.js";
import { loadConfig, userConfigPath } from "./config/load.js";

const VERSION = "0.1.0";

function out(msg: string): void {
  process.stdout.write(`${msg}\n`);
}

function err(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

/**
 * Fire-and-forget push: spawn a detached copy of this CLI so the hook returns
 * immediately even on agents that run hooks synchronously (ZCode).
 */
function fireAndForget(argv: string[], cwd: string): void {
  const child = spawn(process.execPath, [__filenameSafe(), ...argv], {
    detached: true,
    stdio: "ignore",
    cwd,
    windowsHide: true,
  });
  child.unref();
}

function __filenameSafe(): string {
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

  fireAndForget(["__send", JSON.stringify(payload)], event.cwd);
  return 0;
}

/** `donechan __send <json>` — internal detached worker. Do not call by hand. */
async function cmdSendInternal(json: string): Promise<number> {
  const config = loadConfig(process.cwd());
  if (!config) return 0;
  let payload: unknown;
  try {
    payload = JSON.parse(json);
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
  args: ["<absolute-path-to-donechan-entry>", "hook"],
  timeoutMs: 8000,
  statusMessage: "DoneChan：推送完成通知",
};

const CODEX_HOOK = {
  type: "command",
  command: "donechan hook",
  commandWindows: "node <absolute-path-to-donechan-entry> hook",
  timeout: 15,
  async: true,
  statusMessage: "DoneChan: pushing done notification",
};

function cmdInstall(agent: string): number {
  const entry = __filenameSafe();
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
      hook.commandWindows = `node ${entry} hook`;
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
                      command: `node ${entry} hook`,
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

function writeUserConfig(sendKey: string): number {
  if (!isValidSendKey(sendKey)) {
    err('invalid sendkey format (expected sctp<uid>t<secret> or SCT...)');
    return 1;
  }
  const path = userConfigPath();
  mkdirSync(dirname(path), { recursive: true });
  const existing = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  existing.sendkey = sendKey;
  writeFileSync(path, JSON.stringify(existing, null, 2));
  out(`✅ sendkey written to ${path}`);
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
      return cmdSendInternal(rest[0] ?? "");
    case "send":
      return cmdSend(rest);
    case "check":
      return cmdCheck();
    case "install":
      return rest[0] ? cmdInstall(rest[0]) : (err("usage: donechan install <zcode|codex|claude>"), 1);
    case "login":
      return rest[0] ? writeUserConfig(rest[0]) : (err("usage: donechan login <sendkey>"), 1);
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
