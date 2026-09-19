import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply, name } from "../adapters/dsh/plugin/index.js";

/** Minimal Cordis Context stand-in that just records the registered listeners. */
function fakeCtx() {
  const listeners = new Map<string, (...args: any[]) => unknown>();
  return {
    listeners,
    on(event: string, handler: (...args: any[]) => unknown) {
      listeners.set(event, handler);
    },
    logger: { warn: () => {} },
  };
}

/** A fake `donechan` CLI that records the argv and the stdin payload it receives. */
function fakeCli(dir: string, recordPath: string) {
  const cli = join(dir, "fake-cli.mjs");
  writeFileSync(
    cli,
    [
      'import { writeFileSync } from "node:fs";',
      "let data = '';",
      'process.stdin.on("data", (c) => { data += c; });',
      'process.stdin.on("end", () => {',
      `  writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({ argv: process.argv.slice(2), payload: JSON.parse(data) }));`,
      "});",
    ].join("\n"),
  );
  return cli;
}

/** Wait for a file the detached child writes, without hanging the suite. */
async function waitForFile(path: string, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      try {
        return JSON.parse(readFileSync(path, "utf8"));
      } catch {
        /* still being written */
      }
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${path}`);
}

/** One session whose log ends with the given assistant content blocks. */
function sessionWith(content: unknown[], id = "sess-1", cwd = "C:\\work") {
  return {
    id,
    header: { cwd },
    snapshotEvents: () => [
      { type: "user/message", data: {} },
      { type: "assistant/message", data: { message: { role: "assistant", content } } },
    ],
  };
}

describe("donechan DSH plugin", () => {
  it("identifies itself to the loader", () => {
    expect(name).toBe("donechan");
  });

  it("pushes the assistant's own words when the turn stops", async () => {
    const dir = mkdtempSync(join(tmpdir(), "donechan-plugin-"));
    const record = join(dir, "record.json");
    const ctx = fakeCtx();
    apply(ctx, { cliPath: fakeCli(dir, record) });

    const handler = ctx.listeners.get("agent/turn-stopping")!;
    expect(typeof handler).toBe("function");
    handler({ agent: { session: sessionWith([{ type: "reasoning", text: "想" }, { type: "text", text: "已修复 DSH 钩子推送" }]) } });

    const seen = await waitForFile(record);
    expect(seen.argv).toEqual(["hook", "--agent", "dsh"]);
    expect(seen.payload.hook_event_name).toBe("Stop");
    expect(seen.payload.source_agent).toBe("dsh");
    expect(seen.payload.last_assistant_message).toBe("已修复 DSH 钩子推送");
    expect(seen.payload.cwd).toBe("C:\\work");
    expect(seen.payload.session_id).toBe("sess-1");
  });

  it("falls back to null when the log holds no assistant text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "donechan-plugin-"));
    const record = join(dir, "record.json");
    const ctx = fakeCtx();
    apply(ctx, { cliPath: fakeCli(dir, record) });

    ctx.listeners.get("agent/turn-stopping")!({ agent: { session: sessionWith([{ type: "tool-call", id: "t1" }]) } });
    const seen = await waitForFile(record);
    expect(seen.payload.last_assistant_message).toBeNull();
  });

  it("pushes the question verbatim before the wait begins, and still allows the tool", async () => {
    const dir = mkdtempSync(join(tmpdir(), "donechan-plugin-"));
    const record = join(dir, "record.json");
    const ctx = fakeCtx();
    apply(ctx, { cliPath: fakeCli(dir, record) });

    const handler = ctx.listeners.get("tools/pre-execute")!;
    const argumentsIn = { questions: [{ id: "q", question: "要改 README 吗？", options: [{ label: "改" }, { label: "不改" }] }] };
    let delegated = false;
    handler(
      { name: "ask_user_question", arguments: argumentsIn, agent: { session: sessionWith([]) } },
      () => {
        delegated = true;
        return Promise.resolve({ kind: "enter" });
      },
    );

    const seen = await waitForFile(record);
    expect(seen.payload.hook_event_name).toBe("PreToolUse");
    expect(seen.payload.tool_name).toBe("ask_user_question");
    expect(seen.payload.tool_input).toEqual(argumentsIn);
    // An observer must not swallow the waterfall.
    expect(delegated).toBe(true);
  });

  it("stays silent for ordinary tool traffic", () => {
    const dir = mkdtempSync(join(tmpdir(), "donechan-plugin-"));
    const record = join(dir, "record.json");
    const ctx = fakeCtx();
    apply(ctx, { cliPath: fakeCli(dir, record) });

    let delegated = false;
    ctx.listeners.get("tools/pre-execute")!(
      { name: "read", arguments: {}, agent: { session: sessionWith([]) } },
      () => {
        delegated = true;
        return Promise.resolve({ kind: "enter" });
      },
    );
    expect(delegated).toBe(true);
    expect(existsSync(record)).toBe(false);
  });

  it("refuses to run without a cliPath instead of throwing at the loader", () => {
    const ctx = fakeCtx();
    expect(() => apply(ctx, {})).not.toThrow();
    expect(ctx.listeners.size).toBe(0);
  });
});
