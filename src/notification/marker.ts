/**
 * Marker protocol: the agent appends a hidden HTML comment to its final reply
 * and DoneChan uses it verbatim as the notification content.
 *
 *   <!--donechan: {"title": "✅ 登录模块完成", "desp": "测试全绿", "short": "登录"}-->
 *
 * Some Markdown renderers escape the opening comment as `\<!--...-->`.
 * Accept that harmless prefix too, so display escaping does not disable the
 * hook protocol.
 *
 * The marker must end a line, and it is looked for in the LAST FEW non-empty
 * lines of the reply — an example quoted in the middle of the body is never
 * treated as a marker, while a short sign-off after the marker (a habit the
 * strongest models have) does not disable it. Field lengths are capped so a
 * marker can never blow up downstream transport limits (Windows argv, HTTP
 * body, card rendering).
 */

export interface MarkerContent {
  title: string;
  desp?: string;
  short?: string;
  tags?: string;
}

// Both-anchored: the line must BE the marker (after trim). A line that merely
// ends with an example ("你要发通知，就写 <!--donechan: ...-->") is prose
// quoting the format, not a marker — firing it would push example content.
const MARKER_RE = /^\\?<!--\s*donechan:\s*(\{.*\})\s*-->$/u;
// Codex renders HTML comments as visible text. Its hidden transport uses an
// empty Markdown link whose URL carries a base64url-encoded JSON marker.
const CODEX_HIDDEN_RE = /^\[\]\(donechan:\/\/([A-Za-z0-9_-]+)\)$/u;

/** How many trailing non-empty lines are scanned for a line-ending marker. */
const TAIL_LINES = 3;

const MAX_TITLE = 100;
const MAX_DESP = 4000;
const MAX_SHORT = 100;
const MAX_TAGS = 100;

const cap = (value: string | undefined, max: number): string | undefined => {
  if (value === undefined) return undefined;
  // Slice on a code-point boundary: cutting between the halves of a surrogate
  // pair would push a lone surrogate that renders as U+FFFD on the phone.
  // charCodeAt(max - 1) is a HIGH surrogate exactly when the cut lands between
  // its two halves — step back one unit so the pair is excluded entirely.
  const low = value.charCodeAt(max - 1);
  const cut = low >= 0xd800 && low <= 0xdbff ? max - 1 : max;
  return value.slice(0, cut);
};

function parseMarkerObject(parsed: unknown): MarkerContent | null {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  const title = cap(typeof obj.title === "string" ? obj.title.trim() : "", MAX_TITLE);
  if (!title) return null;

  const content: MarkerContent = { title };
  if (typeof obj.desp === "string" && obj.desp.trim()) content.desp = cap(obj.desp, MAX_DESP);
  if (typeof obj.short === "string" && obj.short.trim()) content.short = cap(obj.short, MAX_SHORT);
  if (typeof obj.tags === "string" && obj.tags.trim()) content.tags = cap(obj.tags, MAX_TAGS);
  return content;
}

/** Parse the regular HTML-comment marker, optionally allowing Codex's hidden link form. */
export function extractMarker(text: string, options: { allowCodexHidden?: boolean } = {}): MarkerContent | null {
  const lines = text.trimEnd().split(/\r?\n/u);
  const tail = lines.filter((l) => l.trim() !== "").slice(-TAIL_LINES);
  for (const line of tail.reverse()) {
    const candidate = line.trim();
    if (options.allowCodexHidden) {
      const hidden = CODEX_HIDDEN_RE.exec(candidate);
      if (hidden) {
        try {
          const json = Buffer.from(hidden[1]!, "base64url").toString("utf8");
          return parseMarkerObject(JSON.parse(json));
        } catch {
          return null;
        }
      }
    }
    const match = MARKER_RE.exec(candidate);
    if (match) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(match[1]!);
      } catch {
        return null;
      }
      return parseMarkerObject(parsed);
    }
  }
  return null;
}
