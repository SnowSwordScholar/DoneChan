/**
 * Payload handoff between the hook entry (fast, must never block) and the
 * detached send worker.
 *
 * argv is unsuitable: Windows has a ~32k command-line limit and marker bodies
 * are unbounded, so oversized payloads would silently kill the worker. We pass
 * the payload through a temp file instead.
 *
 * Lifecycle: the hook entry stages the file, and the worker deletes the whole
 * staging directory after reading it. To keep deletion safe the worker only
 * removes directories it can prove DoneChan created — a `donechan-` prefix
 * inside the OS temp dir. Startup sweeps orphaned staging dirs left by
 * crashed runs (they can hold notification content).
 */

import { mkdtemp, readFile, rm, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep, isAbsolute } from "node:path";
import { spawn } from "node:child_process";

const STAGING_PREFIX = "donechan-";

export interface Handoff {
  /** Absolute path of the temp file holding the JSON payload. */
  file: string;
  /** Best-effort cleanup of the temp file. */
  cleanup: () => Promise<void>;
}

/** True when `dir` is a `donechan-` staging dir inside the OS temp root. */
export function isOwnStagingDir(dir: string): boolean {
  const abs = resolve(dir);
  const root = resolve(tmpdir());
  return (
    isAbsolute(abs) &&
    abs.startsWith(root + sep) &&
    !abs.slice(root.length + sep.length).includes(sep) &&
    abs.slice(root.length + sep.length).startsWith(STAGING_PREFIX)
  );
}

/** Write the payload to a fresh temp file for a detached worker to consume. */
export async function stageHandoff(payloadJson: string): Promise<Handoff> {
  const dir = await mkdtemp(join(tmpdir(), STAGING_PREFIX));
  const file = join(dir, "payload.json");
  await writeFile(file, payloadJson, "utf8");
  return {
    file,
    cleanup: async () => {
      await rm(dir, { force: true, recursive: true }).catch(() => {});
    },
  };
}

/** Worker side: read a staged payload file, then remove its staging dir. */
export async function readHandoff(file: string): Promise<string> {
  const content = await readFile(file, "utf8");
  const dir = resolve(join(file, ".."));
  // Deletion guard: only ever remove a dir we can positively identify as one
  // of our own staging dirs in the OS temp root. Anything else is left alone.
  if (isOwnStagingDir(dir)) {
    await rm(dir, { force: true, recursive: true }).catch(() => {});
  }
  return content;
}

/** Remove staging dirs from previous runs that were never consumed. */
export async function sweepStaleStaging(maxAgeMs = 24 * 60 * 60 * 1000): Promise<number> {
  let removed = 0;
  try {
    const entries = await readdir(tmpdir());
    for (const name of entries) {
      if (!name.startsWith(STAGING_PREFIX)) continue;
      const dir = join(tmpdir(), name);
      try {
        const info = await stat(dir);
        if (!info.isDirectory()) continue;
        if (Date.now() - info.mtimeMs > maxAgeMs) {
          await rm(dir, { force: true, recursive: true });
          removed += 1;
        }
      } catch {
        /* racing with another process's cleanup is fine */
      }
    }
  } catch {
    /* temp dir unreadable: nothing we can do */
  }
  return removed;
}

/**
 * Spawn a detached worker (`node <entry> __send --payload-file <file>`) that
 * survives the parent's exit. Resolves immediately; the worker's exit is not
 * awaited by design.
 */
export function spawnDetached(entryPath: string, payloadFile: string, cwd: string): void {
  const child = spawn(process.execPath, [entryPath, "__send", "--payload-file", payloadFile], {
    detached: true,
    stdio: "ignore",
    cwd,
    windowsHide: true,
  });
  child.unref();
}

/** Windows cmd.exe quoting (double quotes, doubled inner quotes). */
export function shellQuoteWin(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/** POSIX shell quoting (single quotes with the '\'' escape). */
export function shellQuotePosix(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
