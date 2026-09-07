import type { DoneEvent, Notification } from "../agent/types.js";

const MAX_BODY = 4000;

/**
 * A misplaced donechan marker that failed to parse must never reach the
 * notification content — strip any marker-shaped text before it can leak
 * into the title or body (seen live when a model put the marker mid-reply).
 * Both transport forms are covered: the HTML-comment marker and Codex's
 * hidden `donechan://` link (whose base64url JSON could otherwise surface
 * raw on agents where the hidden form is not enabled). A third branch strips
 * UNTERMINATED prefixes — a marker truncated mid-JSON (responsePreview
 * clipping, a cut transcript tail) has no closing `}-->` to match, and the
 * raw prefix is exactly what must not reach the phone.
 */
const STRIP_MARKER_RE = /\\?<!--\s*donechan:\s*\{[\s\S]*?\}\s*-->/gu;
const STRIP_CODEX_LINK_RE = /\[\]\(donechan:\/\/[A-Za-z0-9_-]+\)/gu;
// A real marker never spans lines (MARKER_RE is single-line), so a truncated
// prefix can be cut at its end of line; later lines are ordinary prose. The
// pattern must stay anchored-free per line: [^\n]* stops at the newline, and
// /m would be needed for a $ anchor — no anchor is simpler and equivalent.
const STRIP_TRUNCATED_RE = /\\?<!--\s*donechan:\s*\{[^\n]*/gu;
// The extractor cuts a marker's JSON at the LAST `}`, the non-greedy strip at
// the FIRST `}-->` — a broken marker whose JSON contains a raw nested comment
// therefore leaves a `"}-->` residue between the two cut points. No opener
// precedes it, so no other pass can catch it; strip the residue directly.
// The closing brace is REQUIRED here (a bare ` -->` is ordinary prose).
const STRIP_RESIDUE_RE = /\s*"?\}\s*-->/gu;

function stripMarker(text: string): string {
  return text
    .replace(STRIP_MARKER_RE, "")
    .replace(STRIP_CODEX_LINK_RE, "")
    .replace(STRIP_RESIDUE_RE, "")
    .replace(STRIP_TRUNCATED_RE, "")
    .trim();
}

function firstMeaningfulLine(text: string): string {
  for (const raw of stripMarker(text).split("\n")) {
    const line = raw.trim();
    // Skip markdown headers/bullets/lists so the title reads like a sentence.
    const cleaned = line.replace(/^([-*#>\s]+|\d+\.\s)+/u, "").trim();
    if (cleaned.length > 0) return cleaned;
  }
  return "";
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  // Cut on a code-point boundary: if the unit just past the cut is a LOW
  // surrogate, the cut splits a surrogate pair — step back one unit so the
  // pair is excluded entirely and the title never ends in a lone surrogate.
  const next = text.charCodeAt(max);
  const cut = next >= 0xdc00 && next <= 0xdfff ? max - 1 : max;
  return `${text.slice(0, cut)}…`;
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
  const reply = stripMarker(event.lastAssistantMessage ?? "");
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
