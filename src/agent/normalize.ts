import type { AgentId, DoneEvent, WaitingInfo } from "./types.js";
import { readLastAssistantText } from "./transcript.js";

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
  transcript_path?: string;
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
  transcript_path?: string | null;
}

/** Payload produced by the DoneChan OpenCode plugin (src/agent/opencode.ts). */
interface OpenCodeStopInput {
  hook_event_name?: string;
  source_agent?: string;
  session_id?: string;
  cwd?: string;
  last_assistant_message?: string | null;
}

/**
 * PreToolUse payload carrying a tool that blocks on the human. DSH's
 * Claude Code bridge puts the tool's full arguments in `tool_input`, so the
 * questions and options reach us verbatim.
 */
interface WaitingToolInput {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: unknown;
  source_agent?: string;
}

/**
 * Tools whose execution *is* the wait: the agent has asked something and the
 * run is parked until the human answers. Firing on PreToolUse (not PostToolUse)
 * is what makes the notification arrive at the moment the question appears.
 */
export const WAITING_TOOLS: readonly string[] = ["ask_user_question", "exit_plan_mode"];

interface CodexLegacyNotifyInput {
  type?: string;
  "thread-id"?: string;
  "turn-id"?: string;
  cwd?: string;
  client?: string;
  "input-messages"?: string[];
  "last-assistant-message"?: string | null;
}

export type RawHookInput = ZCodeStopInput | CodexStopInput | CodexLegacyNotifyInput | OpenCodeStopInput | WaitingToolInput;

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
 *
 * `hint` is the optional `--agent <id>` the installer bakes into the hook
 * command. DSH's Claude Code bridge emits a payload that is field-for-field a
 * Claude Code Stop payload, so the command's own hint is the only reliable way
 * to tell the two apart for tags and labels.
 */
export function detectAgent(input: unknown, hint?: string): AgentId | null {
  if (!asRecord(input)) return null;
  if (input.type === "agent-turn-complete") return "codex-legacy";
  const event = str(input.hook_event_name) ?? str(input.hookEventName);
  const agent = detectByShape(input, event, hint);
  if (agent === null) return null;
  return agent;
}

/** Shared shape rules for the events that carry a notification. */
function detectByShape(input: Record<string, unknown>, event: string | undefined, hint?: string): AgentId | null {
  if (event === "Stop") {
    // ZCode duplicates every field in camelCase (responseText / sessionId /
    // toolCallCount); Codex and Claude Code send only snake_case.
    if ("responseText" in input || "responsePreview" in input || "toolCallCount" in input) {
      return "zcode";
    }
    // OpenCode's plugin (src/agent/opencode.ts) reports itself explicitly; its
    // payload shape is otherwise indistinguishable from a Claude Stop payload.
    if (input.source_agent === "opencode") return "opencode";
    // DoneChan's own DSH plugin (adapters/dsh/plugin) also self-reports, and it
    // does carry the reply — so it must be recognized without relying on the
    // `--agent dsh` hint alone.
    if (input.source_agent === "dsh") return "dsh";
    if (typeof input.model === "string") return "codex";
    return hint === "dsh" ? "dsh" : "claude";
  }
  if (event === "PreToolUse") {
    const tool = str(input.tool_name);
    // Only the tools that park the run waiting on the human are of interest;
    // every other PreToolUse event is ordinary traffic and stays silent.
    if (!tool || !WAITING_TOOLS.includes(tool)) return null;
    if (input.source_agent === "opencode") return "opencode";
    if (input.source_agent === "dsh") return "dsh";
    return hint === "dsh" ? "dsh" : "claude";
  }
  return null;
}

/**
 * Pull the human-facing content out of a waiting tool's arguments.
 *
 * The questions and option labels are the agent's own words, already paid for
 * by the tool call itself — quoting them costs no extra tokens, which is why
 * this path needs no marker protocol.
 */
function waitingInfo(input: Record<string, unknown>): WaitingInfo | null {
  const tool = str(input.tool_name);
  const args = asRecord(input.tool_input) ? (input.tool_input as Record<string, unknown>) : null;
  if (!tool || !args) return null;

  if (tool === "ask_user_question") {
    const questions: string[] = [];
    const options: string[] = [];
    for (const raw of Array.isArray(args.questions) ? args.questions : []) {
      if (!asRecord(raw)) continue;
      const question = str(raw.question);
      if (question) questions.push(question);
      for (const option of Array.isArray(raw.options) ? raw.options : []) {
        if (!asRecord(option)) continue;
        const label = str(option.label);
        if (label) options.push(label);
      }
    }
    return { tool, questions, options };
  }

  if (tool === "exit_plan_mode") {
    const plan = str(args.plan) ?? "";
    // The plan's first heading is the agent's own summary of what it intends
    // to do — the only verbatim line worth putting in a title.
    const heading = plan
      .split("\n")
      .map((line) => line.trim())
      .find((line) => /^#\s+\S/u.test(line));
    return {
      tool,
      questions: heading ? [heading.replace(/^#+\s*/u, "")] : [],
      options: [],
      plan,
    };
  }

  return null;
}

/** Normalize a raw payload into the unified DoneEvent model, or null. */
export function normalize(input: unknown, hint?: string): DoneEvent | null {
  const agent = detectAgent(input, hint);
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

  // A tool that parks the run until the human answers: the run is not done,
  // it is waiting. Notify now rather than at the next Stop.
  if (str(input.hook_event_name) === "PreToolUse") {
    const waiting = waitingInfo(input);
    if (!waiting) return null;
    return {
      agent,
      cwd: str(input.cwd) ?? process.cwd(),
      lastAssistantMessage: null,
      userMessages: [],
      sessionId: str(input.session_id),
      kind: "waiting",
      waiting,
    };
  }

  const common = input as ZCodeStopInput & CodexStopInput;
  let lastAssistantMessage = lastAssistantText(input);
  // Claude Code's Stop payload carries no reply text — only `transcript_path`.
  // Recover the final assistant reply from the transcript so the marker
  // protocol works; without this every Claude notification degrades to the
  // "（无回复内容）" template.
  if (!lastAssistantMessage && typeof common.transcript_path === "string" && common.transcript_path) {
    lastAssistantMessage = readLastAssistantText(common.transcript_path);
  }
  return {
    agent,
    cwd: str(common.cwd) ?? process.cwd(),
    lastAssistantMessage,
    userMessages: [],
    sessionId: str(common.session_id) ?? str(common.sessionId),
    stopHookActive: common.stop_hook_active === true || common.stopHookActive === true,
    toolCallCount: typeof common.toolCallCount === "number" ? common.toolCallCount : undefined,
    timestamp: str(common.timestamp),
  };
}
