import type { DoneEvent, Notification } from "../agent/types.js";

const MAX_BODY = 4000;

function firstMeaningfulLine(text: string): string {
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    // Skip markdown headers/bullets/lists so the title reads like a sentence.
    const cleaned = line.replace(/^([-*#>\s]+|\d+\.\s)+/u, "").trim();
    if (cleaned.length > 0) return cleaned;
  }
  return "";
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

const AGENT_LABEL: Record<DoneEvent["agent"], string> = {
  zcode: "ZCode",
  codex: "Codex",
  "codex-legacy": "Codex",
  claude: "Claude Code",
  opencode: "OpenCode",
};

/** Fallback notification when the reply carries no donechan marker. */
export function buildTemplate(event: DoneEvent): Notification {
  const label = AGENT_LABEL[event.agent];
  const reply = event.lastAssistantMessage ?? "";
  const summary = firstMeaningfulLine(reply);
  const title = summary ? `✅ ${truncate(summary, 80)}` : `✅ ${label} 任务完成`;

  const parts: string[] = [];
  if (event.userMessages.length > 0) {
    parts.push(`**任务**：${truncate(event.userMessages[0]!, 200)}`);
  }
  if (reply) {
    parts.push(truncate(reply, MAX_BODY));
  } else if (event.userMessages.length > 0) {
    // Reply missing entirely (Codex notify without last message): still show the ask.
  } else {
    parts.push("（无回复内容）");
  }

  const meta: string[] = [];
  const shortCwd = shortPath(event.cwd);
  if (shortCwd) meta.push(`📁 ${shortCwd}`);
  if (typeof event.toolCallCount === "number") meta.push(`🔧 ${event.toolCallCount} 次工具调用`);

  const body = meta.length > 0 ? `${parts.join("\n\n")}\n\n---\n${meta.join(" · ")}` : parts.join("\n\n");
  return {
    title,
    body: body || title,
    short: summary ? truncate(summary, 60) : `${label} 任务完成`,
    source: "template",
  };
}

function shortPath(cwd: string): string {
  if (!cwd) return "";
  const segments = cwd.split(/[\\/]/).filter(Boolean);
  return segments.slice(-2).join("/");
}
