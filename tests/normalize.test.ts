import { describe, expect, it } from "vitest";
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
  it("rejects junk", () => {
    expect(detectAgent(null)).toBeNull();
    expect(detectAgent("hello")).toBeNull();
    expect(detectAgent({ foo: 1 })).toBeNull();
    expect(detectAgent({ hook_event_name: "PreToolUse" })).toBeNull();
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
  it("handles null last_assistant_message", () => {
    const e = normalize({ ...CODEX_STOP, last_assistant_message: null })!;
    expect(e.lastAssistantMessage).toBeNull();
  });
  it("returns null for unrecognized input", () => {
    expect(normalize("nope")).toBeNull();
  });
});
