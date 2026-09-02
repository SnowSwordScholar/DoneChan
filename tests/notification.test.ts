import { describe, expect, it } from "vitest";
import { extractMarker } from "../src/notification/marker.js";
import { compose } from "../src/notification/compose.js";
import type { DoneEvent } from "../src/agent/types.js";

function event(overrides: Partial<DoneEvent> = {}): DoneEvent {
  return {
    agent: "zcode",
    cwd: "C:\\Code\\Team\\DoneChan",
    lastAssistantMessage: "搞定",
    userMessages: [],
    ...overrides,
  };
}

describe("extractMarker", () => {
  it("parses a well-formed marker", () => {
    const text = '正文内容\n<!--donechan: {"title": "✅ 登录完成", "desp": "测试全绿", "short": "登录", "tags": "dev"}-->';
    const m = extractMarker(text)!;
    expect(m.title).toBe("✅ 登录完成");
    expect(m.desp).toBe("测试全绿");
    expect(m.short).toBe("登录");
    expect(m.tags).toBe("dev");
  });
  it("tolerates whitespace", () => {
    const m = extractMarker('hi <!--  donechan:  {"title":"T"}  -->')!;
    expect(m.title).toBe("T");
  });
  it("rejects missing title", () => {
    expect(extractMarker('<!--donechan: {"desp":"x"}-->')).toBeNull();
  });
  it("rejects broken JSON", () => {
    expect(extractMarker("<!--donechan: {title}-->")).toBeNull();
  });
  it("returns null when no marker", () => {
    expect(extractMarker("普通回复")).toBeNull();
  });
});

describe("compose", () => {
  it("prefers marker content", () => {
    const n = compose(
      event({
        lastAssistantMessage: '回复<!--donechan: {"title":"AI 定义的标题","desp":"AI 定义的内容"}-->',
      }),
    );
    expect(n.source).toBe("marker");
    expect(n.title).toBe("AI 定义的标题");
    expect(n.body).toBe("AI 定义的内容");
  });
  it("falls back to template without marker", () => {
    const n = compose(event({ lastAssistantMessage: "## 重构完成\n所有测试通过" }));
    expect(n.source).toBe("template");
    expect(n.title).toContain("重构完成");
    expect(n.body).toContain("所有测试通过");
  });
  it("template handles null reply", () => {
    const n = compose(event({ lastAssistantMessage: null }));
    expect(n.title).toBe("✅ ZCode 任务完成");
  });
  it("template includes user request when present", () => {
    const n = compose(event({ agent: "codex-legacy", userMessages: ["修复登录 bug"], lastAssistantMessage: null }));
    expect(n.body).toContain("修复登录 bug");
  });
  it("truncates long titles", () => {
    const n = compose(event({ lastAssistantMessage: "x".repeat(300) }));
    expect(n.title.length).toBeLessThanOrEqual(85);
  });
});
