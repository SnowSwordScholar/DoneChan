import type { AgentId, DoneEvent } from "./types.js";

/**
 * Raw hook payloads, keyed by the wire format each agent uses.
 *
 * ZCode sends both snake_case (Claude-compatible) and camelCase copies of its
 * fields; Codex hooks send snake_case; Codex legacy notify sends kebab-case as
 * the final argv argument; Claude Code sends snake_case.
 */

interface ZCodeStopInput {
  hook_event_name?: string;
  hookEventName?: string;
  session_id?: string;
  sessionId?: string;
  cwd?: string;
  last_assistant_message?: string;
  responseText?: string;
  responsePreview?: string;
  stop_hook_active?: boolean;
  stopHookActive?: boolean;
  toolCallCount?: number;
  timestamp?: string;
}

interface CodexStopInput {
  hook_event_name?: string;
  session_id?: string;
  turn_id?: string;
  cwd?: string;
  model?: string;
  permission_mode?: string;
  stop_hook_active?: boolean;
  last_assistant_message?: string | null;
}

interface CodexLegacyNotifyInput {
  type?: string;
  "thread-id"?: string;
  "turn-id"?: string;
  cwd?: string;
  client?: string;
  "input-messages"?: string[];
  "last-assistant-message"?: string | null;
}

export type RawHookInput = ZCodeStopInput | CodexStopInput | CodexLegacyNotifyInput;

function asRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function lastAssistantText(input: Record<string, unknown>): string | null {
  for (const key of ["last_assistant_message", "last-assistant-message", "responseText", "responsePreview"]) {
    const v = input[key];
    if (typeof v === "string" && v.trim().length > 0) return v;
  }
  return null;
}

/**
 * Identify which agent produced a parsed payload, or null when the payload is
 * not recognizable as any supported hook input.
 */
export function detectAgent(input: unknown): AgentId | null {
  if (!asRecord(input)) return null;
  if (input.type === "agent-turn-complete") return "codex-legacy";
  const event = str(input.hook_event_name) ?? str(input.hookEventName);
  if (event !== "Stop") return null;
  // ZCode duplicates every field in camelCase (responseText / sessionId /
  // toolCallCount); Codex and Claude Code send only snake_case.
  if ("responseText" in input || "responsePreview" in input || "toolCallCount" in input) {
    return "zcode";
  }
  if (typeof input.model === "string") return "codex";
  return "claude";
}

/** Normalize a raw payload into the unified DoneEvent model, or null. */
export function normalize(input: unknown): DoneEvent | null {
  const agent = detectAgent(input);
  if (!agent || !asRecord(input)) return null;

  if (agent === "codex-legacy") {
    const legacy = input as CodexLegacyNotifyInput;
    return {
      agent,
      cwd: str(legacy.cwd) ?? process.cwd(),
      lastAssistantMessage: lastAssistantText(input),
      userMessages: Array.isArray(legacy["input-messages"])
        ? legacy["input-messages"].filter((m): m is string => typeof m === "string")
        : [],
      sessionId: str(legacy["thread-id"]),
    };
  }

  const common = input as ZCodeStopInput & CodexStopInput;
  return {
    agent,
    cwd: str(common.cwd) ?? process.cwd(),
    lastAssistantMessage: lastAssistantText(input),
    userMessages: [],
    sessionId: str(common.session_id) ?? str(common.sessionId),
    stopHookActive: common.stop_hook_active === true || common.stopHookActive === true,
    toolCallCount: typeof common.toolCallCount === "number" ? common.toolCallCount : undefined,
    timestamp: str(common.timestamp),
  };
}
