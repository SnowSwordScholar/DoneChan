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
  it("parses a well-formed marker on the last line", () => {
    const text = '正文内容\n<!--donechan: {"title": "✅ 登录完成", "desp": "测试全绿", "short": "登录", "tags": "dev"}-->';
    const m = extractMarker(text)!;
    expect(m.title).toBe("✅ 登录完成");
    expect(m.desp).toBe("测试全绿");
    expect(m.short).toBe("登录");
    expect(m.tags).toBe("dev");
  });

  it("tolerates CRLF line endings", () => {
    const m = extractMarker('正文\r\n<!--donechan: {"title":"T"}-->')!;
    expect(m.title).toBe("T");
  });

  it("tolerates whitespace around the JSON", () => {
    const m = extractMarker('hi\n  <!--  donechan:  {"title":"T"}  -->  ')!;
    expect(m.title).toBe("T");
  });

  it("accepts a Markdown-escaped opening comment", () => {
    const m = extractMarker('回复\n\\<!--donechan: {"title":"T"}-->')!;
    expect(m.title).toBe("T");
  });

  it("accepts Codex hidden-link markers when enabled", () => {
    const encoded = Buffer.from(JSON.stringify({ title: "隐藏标题", desp: "隐藏正文" }), "utf8").toString("base64url");
    const text = `回复\n[](${"donechan://"}${encoded})`;
    const m = extractMarker(text, { allowCodexHidden: true })!;
    expect(m.title).toBe("隐藏标题");
    expect(m.desp).toBe("隐藏正文");
  });

  it("does not accept Codex hidden-link markers unless enabled", () => {
    const encoded = Buffer.from(JSON.stringify({ title: "T" }), "utf8").toString("base64url");
    expect(extractMarker(`[](${"donechan://"}${encoded})`)).toBeNull();
  });

  it("ignores a marker quoted in the middle of the body", () => {
    const text = '示例如下 <!--donechan: {"title":"误报"}--> 正文继续\n这就是个例子';
    expect(extractMarker(text)).toBeNull();
  });

  it("ignores a marker followed by trailing prose on the same line", () => {
    expect(extractMarker('<!--donechan: {"title":"T"}--> 以上是格式说明')).toBeNull();
  });

  it("uses the last-line marker even when earlier lines quote examples", () => {
    const text = '以前见过 <!--donechan: {"title":"例子"}-->\n真结尾\n<!--donechan: {"title":"真通知"}-->';
    const m = extractMarker(text)!;
    expect(m.title).toBe("真通知");
  });

  it("rejects missing title", () => {
    expect(extractMarker('\n<!--donechan: {"desp":"x"}-->')).toBeNull();
  });

  it("rejects broken JSON", () => {
    expect(extractMarker('\n<!--donechan: {title}-->')).toBeNull();
  });

  it("rejects non-object JSON", () => {
    expect(extractMarker('\n<!--donechan: [1,2]-->')).toBeNull();
  });

  it("returns null when no marker", () => {
    expect(extractMarker("普通回复")).toBeNull();
  });

  it("caps oversized fields", () => {
    const m = extractMarker(`\n<!--donechan: {"title":"${"t".repeat(500)}","desp":"${"d".repeat(99999)}"}-->`)!;
    expect(m.title.length).toBeLessThanOrEqual(100);
    expect(m.desp!.length).toBeLessThanOrEqual(4000);
  });
});

describe("compose", () => {
  it("prefers marker content", () => {
    const n = compose(
      event({
        lastAssistantMessage: '回复\n<!--donechan: {"title":"AI 定义的标题","desp":"AI 定义的内容"}-->',
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
