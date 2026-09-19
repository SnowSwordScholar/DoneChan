import { describe, expect, it } from "vitest";
import { extractMarker } from "../src/notification/marker.js";
import { compose } from "../src/notification/compose.js";
import type { DoneEvent } from "../src/agent/types.js";

function waiting(overrides: Partial<NonNullable<DoneEvent["waiting"]>> = {}): DoneEvent {
  return {
    agent: "dsh",
    cwd: "C:\\Code\\Team\\DoneChan",
    lastAssistantMessage: null,
    userMessages: [],
    kind: "waiting",
    waiting: { tool: "ask_user_question", questions: [], options: [], ...overrides },
  };
}

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

  it("accepts a marker followed by a short sign-off line", () => {
    const m = extractMarker('<!--donechan: {"title":"T"}-->\n✅ 收到，恭候吩咐。')!;
    expect(m.title).toBe("T");
  });

  it("scans up to three trailing non-empty lines", () => {
    const m = extractMarker('<!--donechan: {"title":"T"}-->\n收尾一\n收尾二')!;
    expect(m.title).toBe("T");
  });

  it("ignores a marker more than three trailing lines above the end", () => {
    const text = '<!--donechan: {"title":"T"}-->\n一\n二\n三\n四';
    expect(extractMarker(text)).toBeNull();
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

  it("ignores a prose line that merely ends with an example marker", () => {
    // "就写 <!--donechan: ...-->" is prose quoting the format, not a marker;
    // firing it would push example content to the phone.
    expect(extractMarker('比如你要发通知，就写 <!--donechan: {"title":"错误标题"}-->')).toBeNull();
  });

  it("ignores a fenced example announced as a demo — the marker line alone still counts", () => {
    // Semantic choice: the marker only fires when the line IS the marker
    // (fences don't shield it — a fenced marker line is textually identical
    // to a real one). Prose-prefixed examples stay inert; that is the guard
    // that matters. See the "prose line that merely ends" test above.
    const text = '按照约定，这是标记的样例（本次只是演示，不要发送通知）：\n<!--donechan: {"title":"演示标题","desp":"演示正文"}-->\n以上就是演示。';
    const m = extractMarker(text)!;
    expect(m.title).toBe("演示标题");
  });

  it("caps fields on a code-point boundary", () => {
    // 99 好 (99 units) + 👍 (2 units) = 101 units; cap at 100 would split the
    // pair, so the cut backs off to 99 and excludes the emoji entirely.
    const m = extractMarker(`<!--donechan: {"title":"${"好".repeat(99)}👍"}-->`)!;
    expect(m.title.length).toBe(99);
    expect(m.title).not.toMatch(/[\uD800-\uDFFF](?![\uDC00-\uDFFF])/u);
  });
});

describe("compose", () => {
  it("prefers marker content when the protocol is switched on", () => {
    const n = compose(
      event({
        lastAssistantMessage: '回复\n<!--donechan: {"title":"AI 定义的标题","desp":"AI 定义的内容"}-->',
      }),
      true,
    );
    expect(n.source).toBe("marker");
    expect(n.title).toBe("AI 定义的标题");
    expect(n.body).toBe("AI 定义的内容");
  });
  it("ignores a marker by default — the reply itself is the push", () => {
    const reply = '已修复 DSH 钩子推送\n\n细节说明。\n<!--donechan: {"title":"AI 定义的标题","desp":"AI 定义的内容"}-->';
    const n = compose(event({ lastAssistantMessage: reply }));
    expect(n.source).toBe("template");
    expect(n.title).toBe("✅ 已修复 DSH 钩子推送");
    // The marker never reaches the phone, read or not.
    expect(n.body).not.toContain("donechan");
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
  it("recovers a marker line that stands alone near the end", () => {
    // A marker on its own line right before a sign-off gets marker content:
    // the tail window scans the last three non-empty lines. (A fenced example
    // announced as a demo stays inert — see the ignores tests above.)
    const reply =
      '正文说明。\n\n<!--donechan: {"title":"安装测试通过","desp":"正文"}-->\n\n✅ 收到，陛下。恭候您的下一步吩咐。';
    const n = compose(event({ lastAssistantMessage: reply }), true);
    expect(n.source).toBe("marker");
    expect(n.title).toBe("安装测试通过");
  });
  it("template fallback never leaks a marker that misses the tail window", () => {
    // Live regression: the marker sits more than three non-empty lines above
    // the end, the extractor declines, and the fallback must not echo the raw
    // `<!--donechan: {...}` text to the phone.
    const reply =
      '<!--donechan: {"title":"安装测试通过","desp":"正文"}-->\n\n下面补充说明第一点。\n然后是第二点。\n最后是第三点。\n全部搞定。';
    const n = compose(event({ lastAssistantMessage: reply }));
    expect(n.source).toBe("template");
    expect(n.title).toBe("✅ 下面补充说明第一点。");
    expect(n.body).not.toContain("donechan");
  });
  it("template fallback strips the Codex hidden-link form too", () => {
    // A donechan:// link is marker-shaped content; on agents where the hidden
    // form is not enabled it must not surface raw in the fallback either.
    const encoded = Buffer.from(JSON.stringify({ title: "H" }), "utf8").toString("base64url");
    const n = compose(event({ lastAssistantMessage: `正文\n[](donechan://${encoded})` }));
    expect(n.source).toBe("template");
    expect(n.title).toBe("✅ 正文");
    expect(n.body).not.toContain("donechan://");
  });
  it("template fallback strips a truncated marker with no closing -->", () => {
    // responsePreview clipping / transcript tail cuts leave an unterminated
    // prefix; it must never reach the phone (title or body).
    const n = compose(
      event({ lastAssistantMessage: '<!--donechan: {"title":"登录模块重构完成","desp":"全部测试通过，请陛下\n后续的说明文字。' }),
    );
    expect(n.source).toBe("template");
    expect(n.title).toBe("✅ 后续的说明文字。");
    expect(n.body).not.toContain("donechan");
  });
  it("template title never ends in a lone surrogate", () => {
    const n = compose(event({ lastAssistantMessage: "字".repeat(79) + "👍" + "更多说明文字" }));
    expect(n.title).not.toMatch(/[\uD800-\uDFFF](?![\uD800-\uDFFF])/u);
  });
});

describe("compose — waiting notifications", () => {
  it("quotes the agent's question verbatim and lists the options", () => {
    const n = compose(waiting({ questions: ["要不要顺手把 README 也改了？"], options: ["改（推荐）", "不改"] }));
    expect(n.source).toBe("template");
    expect(n.title).toBe("❓ 要不要顺手把 README 也改了？");
    expect(n.body).toContain("- 改（推荐）");
    expect(n.body).toContain("- 不改");
    expect(n.body).toContain("📁");
    expect(n.short).toBe("要不要顺手把 README 也改了？");
  });

  it("puts the plan heading in the title when a plan awaits approval", () => {
    const n = compose(
      waiting({ tool: "exit_plan_mode", questions: ["适配 DSH"], plan: "# 适配 DSH\n\n## 步骤\n- 生成 hooks.json" }),
    );
    expect(n.title).toBe("❓ 适配 DSH");
    expect(n.body).toContain("生成 hooks.json");
  });

  it("never lets marker-shaped text leak out of a question", () => {
    const n = compose(waiting({ questions: ['就写 <!--donechan: {"title":"x"}-->'], options: [] }));
    expect(n.title).not.toContain("donechan:");
    expect(n.body).not.toContain("donechan:");
  });

  it("falls back to a plain label when no question text survived", () => {
    const n = compose(waiting({ questions: ["   "], options: [] }));
    expect(n.title).toContain("DSH");
    // No content section, so the meta line stands alone — never a leading
    // separator after an empty body.
    expect(n.body).toBe("📁 Team/DoneChan");
  });

  it("lists questions after the first one instead of dropping them", () => {
    const n = compose(waiting({ questions: ["第一个问题？", "第二个问题？"], options: [] }));
    expect(n.title).toBe("❓ 第一个问题？");
    expect(n.body).toContain("第二个问题？");
  });
});