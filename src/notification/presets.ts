import type { AgentId, Notification } from "../agent/types.js";

/** Tag applied to pushes based on which agent fired the hook. */
export const AGENT_TAG: Record<AgentId, string> = {
  zcode: "ZCode",
  codex: "Codex",
  "codex-legacy": "Codex",
  claude: "ClaudeCode",
  opencode: "OpenCode",
};

/**
 * Resolve the final ServerChan tags.
 *
 * Default: only the agent tag (ZCode / Codex / ClaudeCode). When
 * `tagsEnabled` (config `marker_tags_enabled`) is on, tags written by the AI
 * in the marker are allowed through as well — opt-in because AI-chosen tags
 * accumulate unboundedly in the app's tag list.
 */
export function resolveTags(agent: AgentId, configTags?: string, markerTags?: string, markerTagsEnabled = false): string | undefined {
  const parts: string[] = [AGENT_TAG[agent]];
  if (markerTagsEnabled && markerTags) parts.push(...markerTags.split("|"));
  else if (configTags) parts.push(...configTags.split("|"));
  return parts.filter(Boolean).join("|") || undefined;
}

/**
 * The default notification for `donechan check` / `donechan send` with no
 * arguments: bilingual, on-brand, and aimed at the boss's phone.
 */
export function testNotification(): Notification {
  return {
    title: "👑 DoneChan 已上线 / DoneChan is live",
    body: [
      "**【中文】** 陛下，奴才来了~",
      "**[EN]** Your Majesty, your humble servant has arrived~",
    ].join("\n\n"),
    short: "奴才来了~ / Done!",
    tags: "DoneChan",
    source: "template",
  };
}
