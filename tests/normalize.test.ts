import { describe, expect, it } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectAgent, normalize } from "../src/agent/normalize.js";

const ZCODE_STOP = {
  hook_event_name: "Stop",
  hookEventName: "Stop",
  session_id: "sess-1",
  sessionId: "sess-1",
  cwd: "C:\\Code\\Team\\DoneChan",
  last_assistant_message: "完成了。",
  responseText: "完成了。",
  responsePreview: "完成了。",
  stop_hook_active: false,
  stopHookActive: false,
  toolCallCount: 7,
  timestamp: "2026-09-02T00:00:00.000Z",
};

const CODEX_STOP = {
  hook_event_name: "Stop",
  session_id: "thread-1",
  turn_id: "42",
  cwd: "/home/u/proj",
  model: "gpt-5.6",
  permission_mode: "default",
  stop_hook_active: false,
  last_assistant_message: "Done.",
  transcript_path: null,
};

const CODEX_LEGACY = {
  type: "agent-turn-complete",
  "thread-id": "t-1",
  "turn-id": "42",
  cwd: "/home/u/proj",
  client: "codex-tui",
  "input-messages": ["Refactor foo"],
  "last-assistant-message": "Refactor complete.",
};

const CLAUDE_STOP = {
  hook_event_name: "Stop",
  session_id: "cc-1",
  transcript_path: "/tmp/x.jsonl",
  cwd: "/home/u/proj",
  hook_event_name_check: true,
  stop_hook_active: false,
  last_assistant_message: "All tests pass.",
};

const OPENCODE_STOP = {
  hook_event_name: "Stop",
  source_agent: "opencode",
  session_id: "oc-1",
  cwd: "/home/u/proj",
  last_assistant_message: "Done.",
};

describe("detectAgent", () => {
  it("identifies ZCode by its camelCase duplicates", () => {
    expect(detectAgent(ZCODE_STOP)).toBe("zcode");
  });
  it("identifies Codex hooks by model field", () => {
    expect(detectAgent(CODEX_STOP)).toBe("codex");
  });
  it("identifies legacy notify payloads", () => {
    expect(detectAgent(CODEX_LEGACY)).toBe("codex-legacy");
  });
  it("defaults snake_case-only Stop payloads to Claude", () => {
    expect(detectAgent(CLAUDE_STOP)).toBe("claude");
  });
  it("identifies OpenCode by its source_agent", () => {
    expect(detectAgent(OPENCODE_STOP)).toBe("opencode");
  });
  it("rejects junk", () => {
    expect(detectAgent(null)).toBeNull();
    expect(detectAgent("hello")).toBeNull();
    expect(detectAgent({ foo: 1 })).toBeNull();
    expect(detectAgent({ hook_event_name: "PreToolUse" })).toBeNull();
  });
});

// DSH's Claude Code bridge: the Stop payload is field-for-field a Claude Code
// Stop payload — no reply text, and an always-empty transcript_path.
const DSH_STOP = {
  hook_event_name: "Stop",
  session_id: "dsh-1",
  transcript_path: "",
  cwd: "C:\\Code\\Team\\DoneChan",
  stop_hook_active: false,
};

const DSH_ASK = {
  hook_event_name: "PreToolUse",
  session_id: "dsh-1",
  cwd: "C:\\Code\\Team\\DoneChan",
  tool_name: "ask_user_question",
  tool_use_id: "call-1",
  tool_input: {
    questions: [
      {
        id: "scope",
        question: "要不要顺手把 README 也改了？",
        header: "范围",
        options: [{ label: "改（推荐）", description: "保持双语一致" }, { label: "不改" }],
      },
      { id: "lang", question: "英文版一起改吗？", options: [{ label: "一起" }, { label: "先中文" }] },
    ],
  },
};

const DSH_PLAN = {
  hook_event_name: "PreToolUse",
  session_id: "dsh-1",
  cwd: "C:\\Code\\Team\\DoneChan",
  tool_name: "exit_plan_mode",
  tool_input: { plan: "# 适配 DSH\n\n## 步骤\n- 生成 hooks.json\n- 挂载钩子桥\n" },
};

describe("DSH payloads", () => {
  it("labels a hinted payload as dsh and an unhinted one as claude", () => {
    expect(detectAgent(DSH_STOP, "dsh")).toBe("dsh");
    // Real Claude Code must keep its own label when no hint is present.
    expect(detectAgent(DSH_STOP)).toBe("claude");
  });

  it("treats a Stop payload with no reply text as a plain done event", () => {
    const e = normalize(DSH_STOP, "dsh")!;
    expect(e.agent).toBe("dsh");
    expect(e.lastAssistantMessage).toBeNull();
    expect(e.kind).toBeUndefined();
  });

  it("turns a blocking question into a waiting event with the questions verbatim", () => {
    const e = normalize(DSH_ASK, "dsh")!;
    expect(e.agent).toBe("dsh");
    expect(e.kind).toBe("waiting");
    expect(e.waiting!.tool).toBe("ask_user_question");
    expect(e.waiting!.questions).toEqual(["要不要顺手把 README 也改了？", "英文版一起改吗？"]);
    expect(e.waiting!.options).toEqual(["改（推荐）", "不改", "一起", "先中文"]);
    expect(e.cwd).toBe("C:\\Code\\Team\\DoneChan");
  });

  it("turns a submitted plan into a waiting event with its heading", () => {
    const e = normalize(DSH_PLAN, "dsh")!;
    expect(e.kind).toBe("waiting");
    expect(e.waiting!.tool).toBe("exit_plan_mode");
    expect(e.waiting!.questions).toEqual(["适配 DSH"]);
    expect(e.waiting!.plan).toContain("生成 hooks.json");
  });

  it("stays silent for ordinary tool traffic", () => {
    expect(detectAgent({ ...DSH_ASK, tool_name: "read" }, "dsh")).toBeNull();
    expect(normalize({ ...DSH_ASK, tool_name: "read" }, "dsh")).toBeNull();
  });

  it("still reports a waiting event when the tool arguments carry nothing usable", () => {
    // The agent is parked on the human either way, so the event must not be
    // dropped; it just yields a content-free waiting notification.
    const e = normalize({ ...DSH_ASK, tool_input: {} }, "dsh")!;
    expect(e.kind).toBe("waiting");
    expect(e.waiting!.questions).toEqual([]);
    expect(e.waiting!.options).toEqual([]);
    // A payload that is not a tool call at all stays silent.
    expect(normalize({ ...DSH_ASK, tool_input: "junk" }, "dsh")).toBeNull();
  });
});

describe("normalize", () => {
  it("maps ZCode fields", () => {
    const e = normalize(ZCODE_STOP)!;
    expect(e.agent).toBe("zcode");
    expect(e.cwd).toBe("C:\\Code\\Team\\DoneChan");
    expect(e.lastAssistantMessage).toBe("完成了。");
    expect(e.toolCallCount).toBe(7);
    expect(e.sessionId).toBe("sess-1");
  });
  it("maps Codex hook fields", () => {
    const e = normalize(CODEX_STOP)!;
    expect(e.agent).toBe("codex");
    expect(e.lastAssistantMessage).toBe("Done.");
    expect(e.sessionId).toBe("thread-1");
  });
  it("maps legacy notify with user messages", () => {
    const e = normalize(CODEX_LEGACY)!;
    expect(e.agent).toBe("codex-legacy");
    expect(e.userMessages).toEqual(["Refactor foo"]);
    expect(e.lastAssistantMessage).toBe("Refactor complete.");
  });
  it("maps OpenCode plugin fields", () => {
    const e = normalize(OPENCODE_STOP)!;
    expect(e.agent).toBe("opencode");
    expect(e.lastAssistantMessage).toBe("Done.");
    expect(e.sessionId).toBe("oc-1");
  });
  it("handles null last_assistant_message", () => {
    const e = normalize({ ...CODEX_STOP, last_assistant_message: null })!;
    expect(e.lastAssistantMessage).toBeNull();
  });
  it("returns null for unrecognized input", () => {
    expect(normalize("nope")).toBeNull();
  });
  it("recovers the reply from transcript_path when last_assistant_message is absent", () => {
    const transcript = [
      JSON.stringify({ type: "assistant", isSidechain: true, message: { role: "assistant", content: [{ type: "text", text: "子代理回复" }] } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "正文回复" }] } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1" }] } }),
    ].join("\n");
    const file = join(mkdtempSync(join(tmpdir(), "donechan-test-")), "t.jsonl");
    writeFileSync(file, transcript, "utf8");
    const e = normalize({ ...CLAUDE_STOP, transcript_path: file, last_assistant_message: undefined })!;
    expect(e.agent).toBe("claude");
    expect(e.lastAssistantMessage).toBe("正文回复");
  });
  it("falls back to null reply when the transcript is missing", () => {
    const e = normalize({ ...CLAUDE_STOP, transcript_path: "Z:/no/such/file.jsonl", last_assistant_message: undefined })!;
    expect(e.lastAssistantMessage).toBeNull();
  });
});
