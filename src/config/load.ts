/**
 * Configuration discovery.
 *
 * Precedence:
 *   1. Environment variables: DONECHAN_SENDKEY, DONECHAN_TITLE_PREFIX, DONECHAN_TAGS
 *   2. ~/.donechan/config.json (user scope)
 *   3. .donechan/config.json walking up from the event cwd (project scope)
 */

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isValidSendKey } from "../channel/serverchan.js";

export interface DoneChanConfig {
  sendKey: string;
  titlePrefix?: string;
  tags?: string;
}

interface ConfigFile {
  sendkey?: string;
  title_prefix?: string;
  tags?: string;
}

function readConfigFile(path: string): ConfigFile | null {
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed as ConfigFile;
  } catch {
    return null;
  }
}

/** Walk upward from `startDir` looking for a `.donechan/config.json`. */
export function findProjectConfig(startDir: string): string | null {
  let dir = resolve(startDir);
  for (;;) {
    const candidate = join(dir, ".donechan", "config.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function loadConfig(eventCwd: string): DoneChanConfig | null {
  let sendKey = process.env.DONECHAN_SENDKEY ?? "";
  let titlePrefix = process.env.DONECHAN_TITLE_PREFIX ?? "";
  let tags = process.env.DONECHAN_TAGS ?? "";

  const userFile = readConfigFile(join(homedir(), ".donechan", "config.json"));
  const projectPath = findProjectConfig(eventCwd);
  const projectFile = projectPath ? readConfigFile(projectPath) : null;

  // Project scope overrides user scope for non-secret fields; the key falls
  // back through project → user → env so a repo can never silently replace a
  // user's personal key choice... actually the reverse: env > project > user,
  // so a user can always override a repo-committed key with their own.
  sendKey = sendKey || projectFile?.sendkey || userFile?.sendkey || "";
  titlePrefix = titlePrefix || projectFile?.title_prefix || userFile?.title_prefix || "";
  tags = tags || projectFile?.tags || userFile?.tags || "";

  if (!sendKey || !isValidSendKey(sendKey)) return null;
  return { sendKey, titlePrefix: titlePrefix || undefined, tags: tags || undefined };
}

/** Where a user-level config file lives (for `donechan install`). */
export function userConfigPath(): string {
  return join(homedir(), ".donechan", "config.json");
}
