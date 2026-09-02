/**
 * Marker protocol: the agent appends a hidden HTML comment to its final reply
 * and DoneChan uses it verbatim as the notification content.
 *
 *   <!--donechan: {"title": "✅ 登录模块完成", "desp": "测试全绿", "short": "登录完成"}-->
 *
 * The regex tolerates whitespace and requires the JSON object to sit on a
 * single line (agents write it as the last line of the reply).
 */

export interface MarkerContent {
  title: string;
  desp?: string;
  short?: string;
  tags?: string;
}

const MARKER_RE = /<!--\s*donechan:\s*(\{.*\})\s*-->/;

export function extractMarker(text: string): MarkerContent | null {
  const match = MARKER_RE.exec(text);
  if (!match) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  const title = typeof obj.title === "string" ? obj.title.trim() : "";
  if (!title) return null;

  const content: MarkerContent = { title };
  if (typeof obj.desp === "string" && obj.desp.trim()) content.desp = obj.desp;
  if (typeof obj.short === "string" && obj.short.trim()) content.short = obj.short;
  if (typeof obj.tags === "string" && obj.tags.trim()) content.tags = obj.tags;
  return content;
}
