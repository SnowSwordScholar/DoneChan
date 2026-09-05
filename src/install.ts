/**
 * Interactive installer: detects existing wiring, shows what will change, and
 * writes agent config only after the user confirms. Supports zcode, codex,
 * claude, and opencode, plus skill installation so agents learn the marker
 * protocol.
 */

import { readFileSync, existsSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig } from "./config/load.js";
import { opencodePluginSource } from "./agent/opencode.js";
import { shellQuoteWin, shellQuotePosix } from "./handoff.js";

export type AgentName = "zcode" | "codex" | "claude" | "opencode";
export const AGENTS: AgentName[] = ["zcode", "codex", "claude", "opencode"];

/** The hook block DoneChan manages, versioned so future upgrades can migrate. */
export interface DoneChanHookBlock {
  _donechan?: { version: string; installedAt: string };
  [key: string]: unknown;
}

/** What kind of donechan wiring already exists in the target. */
export type ExistingKind = "none" | "marked" | "legacy" | "unknown";

export interface InstallPlan {
  agent: AgentName;
  /** Absolute path of the config file that will be written. */
  configPath: string;
  /** What kind of donechan hook already exists (see ExistingKind). */
  existing: ExistingKind;
  /** Previously installed donechan version, if any. */
  existingVersion?: string;
  /** True when the config file already exists (merge vs create). */
  fileExists: boolean;
  /** True when a foreign Stop hook (not donechan's) exists alongside. */
  conflictingStopHook: boolean;
  /** Skill target directory for this agent. */
  skillDir: string;
  /** True when the skill file is already present. */
  skillInstalled: boolean;
}

// ---------------------------------------------------------------------------
// Per-agent paths
// ---------------------------------------------------------------------------

export function zcodeConfigPath(): string {
  return join(homedir(), ".zcode", "cli", "config.json");
}
export function codexConfigPath(): string {
  return join(homedir(), ".codex", "hooks.json");
}
export function claudeConfigPath(): string {
  return join(homedir(), ".claude", "settings.json");
}
export function opencodePluginDir(): string {
  return join(homedir(), ".config", "opencode", "plugins");
}
export function opencodePluginPath(): string {
  return join(opencodePluginDir(), "donechan.js");
}

export function skillTargetDir(agent: AgentName): string {
  switch (agent) {
    case "zcode":
      return join(homedir(), ".zcode", "skills", "donechan-notify");
    case "codex":
      return join(homedir(), ".codex", "skills", "donechan-notify");
    case "claude":
      return join(homedir(), ".claude", "skills", "donechan-notify");
    case "opencode":
      // OpenCode uses AGENTS.md-style instructions, not a skills dir; the
      // skill content is appended to the global AGENTS.md instead.
      return join(homedir(), ".config", "opencode");
  }
}

/** Locate the bundled skill source (works from repo checkout and npm package). */
export function skillSourceFile(entryPath: string): string | null {
  // entryPath is e.g. <root>/dist/cli.js (npm: <pkg>/dist/cli.js) — the
  // package root is two levels up. Use resolve() so Windows/POSIX both work.
  const pkgRoot = resolve(entryPath, "..", "..");
  const candidates = [
    join(pkgRoot, "skills", "donechan-notify", "SKILL.md"),
    // Fallback: source checkout running via tsx from src/.
    join(pkgRoot, "..", "skills", "donechan-notify", "SKILL.md"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

/** Locate the separate Codex skill bundled with the package/check-out. */
export function codexSkillSourceFile(entryPath: string): string | null {
  const pkgRoot = resolve(entryPath, "..", "..");
  const candidates = [
    join(pkgRoot, "skills", "donechan-notify-codex", "SKILL.md"),
    join(pkgRoot, "..", "skills", "donechan-notify-codex", "SKILL.md"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

// ---------------------------------------------------------------------------
// DoneChan hook detection
// ---------------------------------------------------------------------------

/**
 * Classify a hook entry as ours. `_donechan` markers are definitive; hooks
 * installed before the marker existed (e.g. hand-written per the early README,
 * or by older versions) are recognized by their shape: a hook invoking
 * donechan with a `hook` argument.
 */
export function isDoneChanHook(hook: unknown): boolean {
  if (typeof hook !== "object" || hook === null) return false;
  if ("_donechan" in (hook as object)) return true;
  const h = hook as { command?: unknown; args?: unknown };
  const argsText = Array.isArray(h.args) ? h.args.join(" ") : "";
  const commandText = typeof h.command === "string" ? h.command : "";
  const commandWindows = typeof (h as { commandWindows?: unknown }).commandWindows === "string"
    ? String((h as { commandWindows?: unknown }).commandWindows)
    : "";
  // Windows paths are case-insensitive (DoneChan vs donechan), so match loosely.
  const combined = `${commandText} ${commandWindows} ${argsText}`.toLowerCase();
  return combined.includes("donechan") && /(^|\s|")hook(\s|"|$)/.test(combined);
}

function scanStopGroups(hooks: unknown): { existing: ExistingKind; existingVersion?: string; foreignStopHook: boolean } {
  const result = { existing: "none" as ExistingKind, existingVersion: undefined as string | undefined, foreignStopHook: false };
  if (typeof hooks !== "object" || hooks === null) return result;
  const h = hooks as { events?: { Stop?: unknown }; Stop?: unknown };
  // ZCode/Codex wrap groups in hooks.events.Stop; Claude Code uses hooks.Stop.
  const stop = Array.isArray(h.events?.Stop) ? h.events!.Stop : Array.isArray(h.Stop) ? h.Stop : undefined;
  if (!Array.isArray(stop)) return result;
  for (const group of stop) {
    if (typeof group !== "object" || group === null) continue;
    const hooksArr = (group as { hooks?: unknown }).hooks;
    if (!Array.isArray(hooksArr)) continue;
    for (const hook of hooksArr) {
      if (isDoneChanHook(hook)) {
        if (result.existing === "none") result.existing = "legacy";
        if (typeof hook === "object" && hook !== null && "_donechan" in (hook as object)) {
          result.existing = "marked";
          const marker = (hook as DoneChanHookBlock)._donechan;
          if (marker && typeof marker === "object") {
            result.existingVersion = String((marker as { version?: unknown }).version ?? "unknown");
          }
        }
      } else if (typeof hook === "object" && hook !== null) {
        result.foreignStopHook = true;
      }
    }
  }
  return result;
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

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

/** Inspect the ZCode config and describe what install would do. */
export function planZcodeInstall(configPath = zcodeConfigPath()): InstallPlan {
  const skillDir = skillTargetDir("zcode");
  const skillInstalled = existsSync(join(skillDir, "SKILL.md"));
  if (!existsSync(configPath)) {
    return { agent: "zcode", configPath, existing: "none", fileExists: false, conflictingStopHook: false, skillDir, skillInstalled };
  }
  const { ok, root } = readJsonRoot(configPath);
  if (!ok) {
    return { agent: "zcode", configPath, existing: "unknown", fileExists: true, conflictingStopHook: false, skillDir, skillInstalled };
  }
  const scan = scanStopGroups(root.hooks);
  return {
    agent: "zcode",
    configPath,
    existing: scan.existing,
    existingVersion: scan.existingVersion,
    fileExists: true,
    conflictingStopHook: scan.foreignStopHook,
    skillDir,
    skillInstalled,
  };
}

/** Inspect the Codex hooks.json and describe what install would do. */
export function planCodexInstall(configPath = codexConfigPath()): InstallPlan {
  const skillDir = skillTargetDir("codex");
  const skillInstalled = existsSync(join(skillDir, "SKILL.md"));
  if (!existsSync(configPath)) {
    return { agent: "codex", configPath, existing: "none", fileExists: false, conflictingStopHook: false, skillDir, skillInstalled };
  }
  const { ok, root } = readJsonRoot(configPath);
  if (!ok) {
    return { agent: "codex", configPath, existing: "unknown", fileExists: true, conflictingStopHook: false, skillDir, skillInstalled };
  }
  const scan = scanStopGroups(root.hooks);
  return {
    agent: "codex",
    configPath,
    existing: scan.existing,
    existingVersion: scan.existingVersion,
    fileExists: true,
    conflictingStopHook: scan.foreignStopHook,
    skillDir,
    skillInstalled,
  };
}

/** Inspect the Claude settings.json and describe what install would do. */
export function planClaudeInstall(configPath = claudeConfigPath()): InstallPlan {
  const skillDir = skillTargetDir("claude");
  const skillInstalled = existsSync(join(skillDir, "SKILL.md"));
  if (!existsSync(configPath)) {
    return { agent: "claude", configPath, existing: "none", fileExists: false, conflictingStopHook: false, skillDir, skillInstalled };
  }
  const { ok, root } = readJsonRoot(configPath);
  if (!ok) {
    return { agent: "claude", configPath, existing: "unknown", fileExists: true, conflictingStopHook: false, skillDir, skillInstalled };
  }
  const scan = scanStopGroups(root.hooks);
  return {
    agent: "claude",
    configPath,
    existing: scan.existing,
    existingVersion: scan.existingVersion,
    fileExists: true,
    conflictingStopHook: scan.foreignStopHook,
    skillDir,
    skillInstalled,
  };
}

/** Inspect OpenCode's plugin dir. OpenCode has no JSON merge; the plugin file is self-contained. */
export function planOpencodeInstall(pluginPath = opencodePluginPath()): InstallPlan {
  const skillDir = skillTargetDir("opencode");
  const skillInstalled = existsSync(join(skillDir, "AGENTS.md")) && readFileSync(join(skillDir, "AGENTS.md"), "utf8").includes("donechan");
  return {
    agent: "opencode",
    configPath: pluginPath,
    existing: existsSync(pluginPath) ? "legacy" : "none",
    fileExists: existsSync(pluginPath),
    conflictingStopHook: false,
    skillDir,
    skillInstalled,
  };
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

/** Build the ZCode hooks object: `enabled:true` + its Stop hook. */
export function buildZcodeHooks(entry: string, version: string, now = new Date()): Record<string, unknown> {
  return {
    enabled: true,
    events: {
      Stop: [
        {
          hooks: [
            {
              _donechan: { version, installedAt: now.toISOString() },
              type: "process",
              command: "node",
              args: [entry, "hook"],
              timeoutMs: 8000,
              statusMessage: "DoneChan：推送完成通知",
            },
          ],
        },
      ],
    },
  };
}

/** Build the Codex hooks object (shell command with platform quoting). */
export function buildCodexHooks(entry: string, version: string, now = new Date()): Record<string, unknown> {
  const commandPath = process.platform === "win32" ? shellQuoteWin(entry) : shellQuotePosix(entry);
  return {
    Stop: [
      {
        hooks: [
          {
            _donechan: { version, installedAt: now.toISOString() },
            type: "command",
            command: `node ${commandPath} hook`,
            commandWindows: `node ${shellQuoteWin(entry)} hook`,
            timeout: 15,
            async: true,
            statusMessage: "DoneChan: pushing done notification",
          },
        ],
      },
    ],
  };
}

/** Build the Claude settings hooks object (shell command with platform quoting). */
export function buildClaudeHooks(entry: string, version: string, now = new Date()): Record<string, unknown> {
  const commandPath = process.platform === "win32" ? shellQuoteWin(entry) : shellQuotePosix(entry);
  return {
    Stop: [
      {
        hooks: [
          {
            _donechan: { version, installedAt: now.toISOString() },
            type: "command",
            command: `node ${commandPath} hook`,
            commandWindows: `node ${shellQuoteWin(entry)} hook`,
            async: true,
            timeout: 15,
          },
        ],
      },
    ],
  };
}

/**
 * Merge a built hooks block into an existing config root. Stop groups
 * recognized as donechan's (marked or legacy-shape) are replaced; foreign
 * groups and all other keys/events are preserved untouched. Also forces
 * `hooks.enabled: true` (ZCode config-file hooks are disabled by default).
 */
export function mergeHooks(root: Record<string, unknown>, hooksBlock: Record<string, unknown>): Record<string, unknown> {
  const existingHooks = (root.hooks ?? {}) as Record<string, unknown>;
  const existingEvents = (existingHooks.events ?? {}) as Record<string, unknown>;
  const incomingEvents = (hooksBlock.events ?? {}) as Record<string, unknown>;
  const incomingStop = (incomingEvents.Stop ?? []) as unknown[];
  const existingStop = Array.isArray(existingEvents.Stop) ? existingEvents.Stop : [];
  const foreignGroups = existingStop.filter(
    (group) =>
      typeof group !== "object" ||
      group === null ||
      !Array.isArray((group as { hooks?: unknown }).hooks) ||
      ((group as { hooks?: unknown[] }).hooks ?? []).some((h) => !isDoneChanHook(h)),
  );
  const mergedStop = [...foreignGroups, ...incomingStop];
  return {
    ...root,
    hooks: {
      ...existingHooks,
      enabled: true, // config-file hooks are disabled by default in ZCode
      events: {
        ...existingEvents,
        ...incomingEvents,
        Stop: mergedStop,
      },
    },
  };
}

/**
 * Merge a built Stop block into an existing config root for agents that keep
 * Stop groups directly under `hooks` — Codex hooks.json and Claude Code
 * settings.json (no `events` wrapper, unlike ZCode). DoneChan groups are
 * replaced; foreign groups and unrelated keys are preserved.
 */
export function mergeStopHooks(root: Record<string, unknown>, stopBlock: Record<string, unknown>): Record<string, unknown> {
  const existingHooks = (root.hooks ?? {}) as Record<string, unknown>;
  const existingStop = Array.isArray(existingHooks.Stop) ? existingHooks.Stop : [];
  const incomingStop = (stopBlock.Stop ?? []) as unknown[];
  const foreignGroups = existingStop.filter(
    (group) =>
      typeof group !== "object" ||
      group === null ||
      !Array.isArray((group as { hooks?: unknown }).hooks) ||
      ((group as { hooks?: unknown[] }).hooks ?? []).some((h) => !isDoneChanHook(h)),
  );
  return {
    ...root,
    hooks: {
      ...existingHooks,
      Stop: [...foreignGroups, ...incomingStop],
    },
  };
}

// ---------------------------------------------------------------------------
// Skill install
// ---------------------------------------------------------------------------

/**
 * Copy the marker-protocol skill into the agent's skill directory. For
 * OpenCode, appends a short section to ~/.config/opencode/AGENTS.md instead
 * (OpenCode has no skills dir).
 * @returns "copied" | "already" | "missing-source"
 */
export function installSkill(
  agent: AgentName,
  version: string,
  entryPath: string,
  sourceFile: string | null,
): "copied" | "already" | "missing-source" {
  if (agent === "opencode") {
    const dir = skillTargetDir(agent);
    const agentsMd = join(dir, "AGENTS.md");
    mkdirSync(dir, { recursive: true });
    const existing = existsSync(agentsMd) ? readFileSync(agentsMd, "utf8") : "";
    if (existing.includes("donechan")) return "already";
    const section = [
      "",
      "## DoneChan 通知协议",
      "",
      "完成用户交办的重要任务后，在回复最后一行追加（DoneChan 会推送该内容到用户手机）：",
      "",
      "<!--donechan: {\"title\": \"≤30字标题\", \"desp\": \"Markdown 正文\", \"short\": \"摘要\", \"tags\": \"标签\"}-->",
      "",
      "只在任务真正完成时使用；纯问答、等待输入时不要加标记。详见 donechan 包内 skills/donechan-notify/SKILL.md。",
      "",
    ].join("\n");
    writeFileSync(agentsMd, existing + section);
    return "copied";
  }
  // Codex installs its own complete skill (donechan-notify-codex) — the
  // caller picks the right source via codexSkillSourceFile().
  if (!sourceFile) return "missing-source";
  const dir = skillTargetDir(agent);
  mkdirSync(dir, { recursive: true });
  copyFileSync(sourceFile, join(dir, "SKILL.md"));
  return "copied";
}

/** Remove the skill file/dir installed for an agent. */
export function uninstallSkill(agent: AgentName): boolean {
  const dir = skillTargetDir(agent);
  if (agent === "codex") {
    const generic = join(dir, "SKILL.md");
    // Remove the current Codex skill and the old split adapter directory, if
    // present. The latter is intentionally limited to the known DoneChan path.
    const legacyAdapterDir = join(homedir(), ".codex", "skills", "donechan-notify-codex");
    const legacyAdapter = join(legacyAdapterDir, "SKILL.md");
    const hadAny = existsSync(generic) || existsSync(legacyAdapter);
    if (hadAny) {
      rmSync(dir, { recursive: true, force: true });
      rmSync(legacyAdapterDir, { recursive: true, force: true });
    }
    return hadAny;
  }
  if (agent === "opencode") {
    const agentsMd = join(dir, "AGENTS.md");
    if (!existsSync(agentsMd)) return false;
    const content = readFileSync(agentsMd, "utf8");
    if (!content.includes("DoneChan 通知协议")) return false;
    const idx = content.indexOf("## DoneChan 通知协议");
    writeFileSync(agentsMd, content.slice(0, idx).trimEnd() + "\n");
    return true;
  }
  const file = join(dir, "SKILL.md");
  if (!existsSync(file)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

// ---------------------------------------------------------------------------
// Confirmation
// ---------------------------------------------------------------------------

export interface InstallAnswer {
  proceed: boolean;
  /** Whether to install/refresh the marker-protocol skill (user-chosen). */
  installSkill: boolean;
}

/**
 * Confirmation reader. Uses a single `line` listener over stdin for the whole
 * process lifetime: creating a fresh readline/promises interface per question
 * breaks after the first `close()` when stdin is a pipe (the second interface
 * never resolves — Node destroys the stream on close), which stalled
 * `install all`. Piped answers are buffered up-front; TTY input falls back to
 * the question() API which works interactively.
 */
export class ConfirmReader {
  private pipedLines: string[] | null = null;

  private async primePiped(): Promise<void> {
    if (process.stdin.isTTY) {
      this.pipedLines = null;
      return;
    }
    const { createInterface } = await import("node:readline");
    const lines: string[] = [];
    const rl = createInterface({ input: process.stdin });
    rl.on("line", (l) => lines.push(l.trim()));
    const ended = new Promise<void>((res) => rl.once("close", res));
    await ended;
    this.pipedLines = lines;
  }

  async ask(question: string, print: (msg: string) => void): Promise<string> {
    if (this.pipedLines === null && !process.stdin.isTTY) {
      await this.primePiped();
    }
    if (this.pipedLines !== null) {
      return this.pipedLines.shift() ?? "";
    }
    const { createInterface } = await import("node:readline/promises");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return (await rl.question(question)).trim();
    } finally {
      rl.close();
    }
  }
}

const confirmReader = new ConfirmReader();

/**
 * Ask the user for confirmation for one agent install. Always asks to apply
 * the hook config. When `batch` is false and the skill is not yet installed,
 * also offers a separate choice on whether to inject the marker-protocol
 * skill — surfaced especially for Claude Code, whose renderer shows the
 * marker verbatim (it cannot be hidden there).
 */
export async function confirmPlan(
  plan: InstallPlan,
  print: (msg: string) => void = console.log,
  batch = false,
): Promise<InstallAnswer> {
  print(`目标文件 / target: ${plan.configPath}`);
  print(`  ${plan.fileExists ? "已存在，将合并 / exists, will merge" : "不存在，将创建 / missing, will create"}`);
  switch (plan.existing) {
    case "marked":
      print(`  检测到 DoneChan 已安装（版本 ${plan.existingVersion ?? "unknown"}），将原地升级 / existing install found, upgrading in place`);
      break;
    case "legacy":
      print("  检测到旧版 DoneChan 钩子（无版本标记），将替换并加版本标记 / legacy hook found, replacing in place");
      break;
    case "unknown":
      print("  ⚠ 配置文件不是有效 JSON，无法安全合并 / config is not valid JSON");
      break;
    default:
      break;
  }
  if (plan.conflictingStopHook) {
    print("  ⚠ 检测到其他 Stop 钩子，将保留不动 / existing foreign Stop hooks will be preserved");
  }
  if (plan.agent === "claude") {
    print("  ℹ Claude Code 会显示标记原文，无法隐藏 / the marker will be visible in Claude Code replies");
  }

  const proceedAnswer = await confirmReader.ask("写入钩子配置？[y/N] / write hook config? [y/N] ", print);
  if (!(proceedAnswer === "y" || proceedAnswer === "yes")) {
    return { proceed: false, installSkill: false };
  }

  // Skill injection is only prompted for a non-batch install when the skill
  // is not yet present. Batch (`install all`) installs the skill implicitly.
  let installSkill = true;
  if (!batch && !plan.skillInstalled) {
    const skillAnswer = await confirmReader.ask(
      "安装 donechan-notify skill，让 AI 自动写通知标记？[Y/n] / install the marker-protocol skill? [Y/n] ",
      print,
    );
    installSkill = !(skillAnswer.toLowerCase() === "n" || skillAnswer.toLowerCase() === "no");
  }
  return { proceed: true, installSkill };
}

/** Preflight shared by every agent install: the sendkey must be configured. */
export function checkSendKey(): boolean {
  const config = loadConfig(process.cwd());
  if (!config) {
    console.error("✗ 未检测到有效 SendKey / no valid sendkey configured");
    console.error("  先运行 / first run:  donechan login sctp<uid>t<secret>");
    return false;
  }
  console.log("✓ SendKey 已配置 / sendkey configured");
  return true;
}

export { opencodePluginSource };
