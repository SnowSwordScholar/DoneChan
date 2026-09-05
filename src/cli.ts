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
import { testNotification, resolveTags } from "./notification/presets.js";
import { isValidSendKey, push } from "./channel/serverchan.js";
import { loadConfig, userConfigPath } from "./config/load.js";
import { stageHandoff, spawnDetached, readHandoff, sweepStaleStaging, shellQuoteWin, shellQuotePosix } from "./handoff.js";
import { checkSendKey, planZcodeInstall, planCodexInstall, planClaudeInstall, planOpencodeInstall, buildZcodeHooks, buildCodexHooks, buildClaudeHooks, mergeHooks, mergeStopHooks, confirmPlan, skillTargetDir, skillSourceFile, codexSkillSourceFile, installSkill, AGENTS, type AgentName } from "./install.js";
import { opencodePluginSource } from "./agent/opencode.js";
import { codexConfigPath, claudeConfigPath, opencodePluginPath, zcodeConfigPath } from "./install.js";

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
  const tags = resolveTags(event.agent, config.tags, notification.tags, config.markerTagsEnabled);
  const payload = {
    title,
    desp: notification.body,
    ...(notification.short ? { short: notification.short } : {}),
    ...(tags ? { tags } : {}),
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
  const preset = testNotification();
  const title = rest.join(" ") || preset.title;
  const result = await push(config.sendKey, {
    title,
    desp: body || preset.body,
    short: preset.short,
    tags: preset.tags,
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

const CODEX_HOOK = {
  type: "command",
  command: "donechan hook",
  commandWindows: "node <donechan-entry-quoted> hook",
  timeout: 15,
  async: true,
  statusMessage: "DoneChan: pushing done notification",
};

/**
 * Interactive install for one agent (or all): preflight the sendkey, detect
 * existing wiring, confirm, then write the agent config and the marker-protocol
 * skill in place. `--print` shows the would-be config instead of writing.
 */
async function cmdInstallInteractive(targets: string[], printOnly: boolean): Promise<number> {
  const agents: AgentName[] = targets.includes("all")
    ? AGENTS
    : targets.filter((t): t is AgentName => (AGENTS as string[]).includes(t));
  if (agents.length === 0) {
    err(`usage: donechan install <${AGENTS.join("|")}|all> [--print]`);
    return 1;
  }
  if (!printOnly && !checkSendKey()) return 1;

  let failures = 0;
  const batch = agents.length > 1;
  for (const agent of agents) {
    if (agents.length > 1) out("");
    const result = await installAgent(agent, printOnly, batch);
    if (result !== 0) failures += 1;
  }
  return failures > 0 ? 1 : 0;
}

async function installAgent(agent: AgentName, printOnly: boolean, batch: boolean): Promise<number> {
  const entry = entryPath();
  const version = VERSION;
  const skillSource = agent === "codex" ? codexSkillSourceFile(entry) : skillSourceFile(entry);

  if (printOnly) {
    switch (agent) {
      case "zcode":
        out(`// 合并进 ${zcodeConfigPath()}：`);
        out(JSON.stringify({ hooks: buildZcodeHooks(entry, version) }, null, 2));
        break;
      case "codex": {
        const hook = JSON.parse(JSON.stringify(CODEX_HOOK));
        hook.command = `node ${shellQuote(entry, process.platform === "win32" ? "win" : "posix")} hook`;
        hook.commandWindows = `node ${shellQuote(entry, "win")} hook`;
        out(`// 写入 ${codexConfigPath()}：`);
        out(JSON.stringify({ hooks: { Stop: [{ hooks: [hook] }] } }, null, 2));
        out("// 注意：Codex 首次加载该 hook 会提示信任确认。");
        out(`// Codex 专用 skill / Codex skill: ${skillTargetDir("codex")}`);
        break;
      }
      case "claude":
        out(`// 合并进 ${claudeConfigPath()}：`);
        out(JSON.stringify({ hooks: buildClaudeHooks(entry, version) }, null, 2));
        break;
      case "opencode":
        out(`// 写入 ${opencodePluginPath()}：`);
        out(opencodePluginSource(entry, version));
        break;
    }
    out(`// skill 安装位置 / skill target: ${skillTargetDir(agent)}`);
    out(`// 并确保已配置 sendkey：{"sendkey": "..."} → ${userConfigPath()}`);
    return 0;
  }

  // Plan + confirm + write.
  const plan = (() => {
    switch (agent) {
      case "zcode":
        return planZcodeInstall();
      case "codex":
        return planCodexInstall();
      case "claude":
        return planClaudeInstall();
      case "opencode":
        return planOpencodeInstall();
    }
  })();

  if (plan.existing === "unknown") {
    err(`✗ ${plan.configPath} 不是有效 JSON，无法安全合并 / not valid JSON, refusing to merge`);
    err("  请手动修复该文件后重试，或使用 donechan install " + agent + " --print 只打印配置。");
    return 1;
  }

  const answer = await confirmPlan(plan, out, batch);
  if (!answer.proceed) {
    out("已取消，未做任何修改 / cancelled, nothing written");
    return 0;
  }

  try {
    // 1. Agent config.
    if (agent === "opencode") {
      mkdirSync(dirname(plan.configPath), { recursive: true });
      writeFileSync(plan.configPath, opencodePluginSource(entry, version));
    } else {
      // ZCode wraps Stop in hooks.events.Stop; Codex and Claude Code both keep
      // Stop directly under hooks (see adapters/codex/hooks.json).
      const hooksBlock = agent === "zcode"
        ? buildZcodeHooks(entry, version)
        : agent === "codex"
          ? buildCodexHooks(entry, version)
          : buildClaudeHooks(entry, version);
      const { root } = readJsonRoot(plan.configPath);
      let merged: Record<string, unknown>;
      if (agent === "zcode") {
        // ZCode's merge also forces hooks.enabled — config-file hooks are
        // disabled by default there; Codex/Claude have no such flag.
        merged = plan.fileExists ? mergeHooks(root, hooksBlock) : { hooks: hooksBlock };
      } else {
        merged = mergeStopHooks(root, hooksBlock);
      }
      mkdirSync(dirname(plan.configPath), { recursive: true });
      writeFileSync(plan.configPath, JSON.stringify(merged, null, 2) + "\n");
    }
    out(`✅ 已写入 ${plan.configPath}`);

    // Codex hooks require a one-time manual trust confirmation.
    if (agent === "codex") {
      out("➡ 前往 Codex 设置 → 钩子 → 用户配置，点击“信任”该 DoneChan 钩子。");
      out("   Go to Codex Settings → Hooks → User config and click Trust on the DoneChan hook.");
    }

    // 2. Skill — only when the user opted in (declining still leaves the hook
    //    working via the template fallback; the AI just won't auto-write markers).
    if (!answer.installSkill) {
      out("ℹ 已跳过 skill 安装（AI 将只发模板兜底通知，不自动写标记）/ skill skipped; template fallback only");
      return 0;
    }
    const skillResult = installSkill(agent, version, entry, skillSource);
    if (skillResult === "copied") {
      out(`✅ skill 已安装 / skill installed → ${agent === "opencode" ? plan.skillDir + "/AGENTS.md" : skillTargetDir(agent) + "/SKILL.md"}`);
    } else if (skillResult === "already") {
      out("ℹ skill 已存在，跳过 / skill already installed");
    } else {
      err(`⚠ skill 源文件缺失（不影响钩子工作）/ skill source missing; the hook still works`);
    }
    return 0;
  } catch (e) {
    err(`✗ 写入失败 / write failed: ${e instanceof Error ? e.message : e}`);
    return 1;
  }
}

function readJsonRoot(path: string): { ok: boolean; root: Record<string, unknown> } {
  if (!existsSync(path)) return { ok: true, root: {} };
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { ok: true, root: parsed as Record<string, unknown> };
    }
    return { ok: false, root: {} };
  } catch {
    return { ok: false, root: {} };
  }
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

/** Settable config keys for `donechan config <key> [value]`. */
interface ConfigKeyMeta {
  desc: string;
  secret?: boolean;
  validate?: (v: string) => true | string;
}

const CONFIG_KEYS: Record<string, ConfigKeyMeta> = {
  sendkey: {
    desc: "Server酱³ SendKey（sctp...t... 或 SCT...）",
    secret: true,
    validate: (v) => (isValidSendKey(v) ? true : "invalid sendkey format (expected sctp<uid>t<secret> or SCT...)"),
  },
  title_prefix: {
    desc: "通知标题前缀（如 [DoneChan]），留空清除",
  },
  tags: {
    desc: "追加在 agent 标签（ZCode 等）之后的静态标签，竖线分隔，留空清除",
  },
  marker_tags_enabled: {
    desc: "是否放行 AI 在 marker 里写的标签（默认 false，防止标签无限增长）",
    validate: (v) => (["true", "false"].includes(v.toLowerCase()) ? true : "must be true or false"),
  },
};

/** `donechan config` — read/write ~/.donechan/config.json fields. */
function cmdConfig(args: string[]): number {
  const [key, ...rest] = args;
  if (!key || key === "list" || key === "--list") {
    out(`配置文件 / config file: ${userConfigPath()}`);
    for (const [name, meta] of Object.entries(CONFIG_KEYS)) {
      const current = readConfigKey(name);
      const shown = meta.secret && current ? `${current.slice(0, 7)}***` : (current ?? "(未设置 / unset)");
      out(`  ${name.padEnd(20)} ${shown}  — ${meta.desc}`);
    }
    return 0;
  }
  if (!(key in CONFIG_KEYS)) {
    err(`unknown config key: ${key}`);
    out(`available: ${Object.keys(CONFIG_KEYS).join(" | ")}`);
    return 1;
  }
  const meta = CONFIG_KEYS[key];
  const value = rest.join(" ");

  // Read current file.
  const path = userConfigPath();
  let root: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) root = parsed as Record<string, unknown>;
    } catch {
      err(`✗ ${path} 不是有效 JSON，请先修复或删除 / not valid JSON`);
      return 1;
    }
  }

  // Read: `donechan config <key>`
  if (value === "") {
    const current = root[key];
    if (meta.secret && typeof current === "string" && current) {
      out(`${key} = ${current.slice(0, 7)}***`);
    } else {
      out(`${key} = ${current ?? "(未设置 / unset)"}`);
    }
    return 0;
  }

  // Write: `donechan config <key> <value>`; empty string clears the key.
  if (meta.validate) {
    const verdict = meta.validate(value);
    if (verdict !== true) {
      err(`✗ ${verdict}`);
      return 1;
    }
  }
  const normalized = meta.validate && key === "marker_tags_enabled" ? value.toLowerCase() : value;
  if (normalized === "") delete root[key];
  else root[key] = normalized;
  mkdirSync(dirname(path), { recursive: true });
  try {
    atomicWritePrivate(path, JSON.stringify(root, null, 2));
  } catch (e) {
    err(`✗ 写入失败 / write failed: ${e instanceof Error ? e.message : e}`);
    return 1;
  }
  out(`✅ ${key} 已保存 / saved → ${path}`);
  return 0;
}

function readConfigKey(key: string): string | undefined {
  const path = userConfigPath();
  if (!existsSync(path)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const v = (parsed as Record<string, unknown>)[key];
      return v === undefined ? undefined : String(v);
    }
  } catch {
    /* unreadable config shows as unset */
  }
  return undefined;
}

function usage(): number {
  out(`DoneChan v${VERSION} — AI 任务完成通知（Server酱³）

用法:
  donechan hook [json]     hook 统一入口（stdin 或 argv JSON），非阻塞
  donechan send [标题]     发送测试通知（-b 正文）
  donechan check           校验配置
  donechan install <agent|all> [--print]
                           交互式接入 agent（zcode | codex | claude | opencode | all），
                           自动写入钩子配置和 donechan-notify skill；--print 仅打印
  donechan config          查看全部配置
  donechan config <key> [<value>]
                           读取/设置配置项（写入值为空字符串即清除）：
                             sendkey               Server酱³ SendKey
                             title_prefix          标题前缀，留空清除
                             tags                  静态标签（竖线分隔），追加在 ZCode 等 agent 标签后
                             marker_tags_enabled   是否放行 AI 生成的标签（true/false，默认 false）
  donechan login <sendkey> 等价于 config sendkey <sendkey>
  donechan --version       版本号

配置文件: ~/.donechan/config.json（项目级 <repo>/.donechan/config.json 优先）
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
    case "install": {
      const agents = rest.filter((a) => a !== "--print");
      const printOnly = rest.includes("--print");
      return await cmdInstallInteractive(agents, printOnly);
    }
    case "login":
      return rest[0] ? cmdLogin(rest[0]) : (err("usage: donechan login <sendkey>"), 1);
    case "config":
      return cmdConfig(rest);
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
