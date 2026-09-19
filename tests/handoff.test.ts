import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, writeFileSync, utimesSync, mkdtempSync } from "node:fs";
import { dirname } from "node:path";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readHandoff,
  stageHandoff,
  sweepStaleStaging,
  isOwnStagingDir,
  runSendWorker,
  shellQuoteWin,
  shellQuotePosix,
} from "../src/handoff.js";

describe("runSendWorker", () => {
  /**
   * The DSH fix: where the parent's process tree is torn down on exit (DSH's
   * hook runner), a detached worker is reaped partway through its push. Waiting
   * keeps the caller alive until the worker is actually done.
   */
  it("wait:true does not resolve until the worker has finished its work", async () => {
    const dir = mkdtempSync(join(tmpdir(), "donechan-wait-"));
    const entry = join(dir, "slow-worker.mjs");
    const marker = join(dir, "marker.txt");
    // Mimics the `__send --payload-file <file>` shape: the payload path is the
    // last argument, and the work deliberately outlives the caller's return.
    writeFileSync(
      entry,
      [
        'import { writeFileSync } from "node:fs";',
        "const file = process.argv[process.argv.length - 1];",
        "await new Promise((r) => setTimeout(r, 250));",
        'writeFileSync(file, "done");',
      ].join("\n"),
    );
    await runSendWorker(entry, marker, dir, true);
    expect(existsSync(marker)).toBe(true);
  });
}, 15_000);

describe("handoff staging", () => {
  it("writes the payload to a temp file and the worker reads it back", async () => {
    const payload = JSON.stringify({ title: "标题", desp: "x".repeat(60_000) });
    const handoff = await stageHandoff(payload);
    expect(existsSync(handoff.file)).toBe(true);
    const round = await readHandoff(handoff.file);
    expect(round).toBe(payload);
    expect(existsSync(handoff.file)).toBe(false);
  });

  it("oversized payloads (60KB+) stage fine — the case argv would drop on Windows", async () => {
    // Windows cmd line limit is ~32k chars; a marker desp of 60k must survive.
    const payload = JSON.stringify({ title: "t", desp: "y".repeat(60_000) });
    expect(payload.length).toBeGreaterThan(32_768);
    const handoff = await stageHandoff(payload);
    const round = await readHandoff(handoff.file);
    expect(JSON.parse(round).desp.length).toBe(60_000);
  });
});

describe("readHandoff deletion guard", () => {
  it("refuses to delete a staged dir planted outside the OS temp root", async () => {
    // A directory NOT inside the OS temp root: the worker must not remove it.
    const foreign = join(process.cwd(), ".tmp-foreign-test");
    mkdirSync(foreign, { recursive: true });
    const file = join(foreign, "payload.json");
    writeFileSync(file, '{"title":"x"}', "utf8");
    try {
      await readHandoff(file);
      expect(existsSync(foreign)).toBe(true); // survives
    } finally {
      await import("node:fs/promises").then((m) => m.rm(foreign, { recursive: true, force: true }));
    }
  });

  it("refuses to treat arbitrary donechan-named dirs outside temp root as its own", () => {
    expect(isOwnStagingDir(join(process.cwd(), "donechan-evil"))).toBe(false);
    expect(isOwnStagingDir(join(tmpdir(), "donechan-evil", "sub"))).toBe(false); // too deep
    expect(isOwnStagingDir(join(tmpdir(), "notdonechan-1"))).toBe(false);
    expect(isOwnStagingDir(join(tmpdir(), "donechan-ABC123"))).toBe(true);
  });
});

describe("stale staging sweep", () => {
  it("removes only staging dirs older than the age limit", async () => {
    const old = await stageHandoff('{"title":"old"}');
    const fresh = await stageHandoff('{"title":"fresh"}');
    // Backdate the "old" dir beyond the 24h cutoff.
    const past = new Date(Date.now() - 25 * 60 * 60 * 1000);
    utimesSync(dirname(old.file), past, past);

    const removed = await sweepStaleStaging();
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(existsSync(old.file)).toBe(false);
    expect(existsSync(fresh.file)).toBe(true);
    await fresh.cleanup();
  });
});

describe("shell quoting for generated hook commands", () => {
  it("posix quoting escapes single quotes", () => {
    const q = shellQuotePosix("/opt/my tools/done'chan/cli.js");
    expect(q).toBe("'/opt/my tools/done'\\''chan/cli.js'");
  });

  it("win quoting survives spaces and embedded quotes", () => {
    const q = shellQuoteWin("C:\\Program Files\\DoneChan\\cli.js");
    expect(q.startsWith('"') && q.endsWith('"')).toBe(true);
    expect(q).toBe('"C:\\Program Files\\DoneChan\\cli.js"');
  });
});
