/**
 * Unified event model produced by normalizing one of the supported
 * agent-hook inputs (ZCode / Codex hooks / Codex legacy notify / Claude Code /
 * OpenCode / DSH).
 */

export type AgentId = "zcode" | "codex" | "codex-legacy" | "claude" | "opencode" | "dsh";

/**
 * Why DoneChan is pushing: the agent finished a turn (`done`), or it stopped
 * mid-run because a tool is waiting for the human to answer or choose
 * (`waiting`).
 */
export type EventKind = "done" | "waiting";

/**
 * What the agent is waiting for. Captured from the tool call that blocks on
 * the human, so the notification can show the question verbatim — no model
 * output (and no extra tokens) is needed to describe it.
 */
export interface WaitingInfo {
  /** The tool blocking on the human (`ask_user_question`, `exit_plan_mode`). */
  tool: string;
  /** Question texts, verbatim from the tool call. */
  questions: string[];
  /** Option labels offered with the questions, flattened across questions. */
  options: string[];
  /** The submitted plan (markdown), present for `exit_plan_mode`. */
  plan?: string;
}

/** What the user originally asked the agent to do, when known. */
export interface DoneEvent {
  /** Which agent fired the hook, as detected from the payload fingerprint. */
  agent: AgentId;
  /** Absolute path of the workspace the agent was working in. */
  cwd: string;
  /** Final assistant message text (may be truncated by the agent, may be null). */
  lastAssistantMessage: string | null;
  /** The user's original prompt(s), when the agent provides them. */
  userMessages: string[];
  /** Agent session/thread identifier, best-effort. */
  sessionId?: string;
  /** True when the Stop hook is being re-entered because a previous Stop hook asked to continue. */
  stopHookActive?: boolean;
  /** Extra context for templates: tool call count, timestamp, etc. */
  toolCallCount?: number;
  timestamp?: string;
  /** `done` (default) or `waiting` when the agent is blocked on the human. */
  kind?: EventKind;
  /** Present when `kind === "waiting"`; describes what is being waited on. */
  waiting?: WaitingInfo;
}

/** A fully-resolved notification ready to be sent through a channel. */
export interface Notification {
  /** Short title, plain text (ServerChan³ `title`). */
  title: string;
  /** Markdown body (ServerChan³ `desp`). */
  body: string;
  /** Optional one-line card summary (ServerChan³ `short`). */
  short?: string;
  /** Optional vertical-bar-separated tags (ServerChan³ `tags`). */
  tags?: string;
  /** How this notification's content was produced. */
  source: "marker" | "template";
}
