/**
 * Unified event model produced by normalizing one of the supported
 * agent-hook inputs (ZCode / Codex hooks / Codex legacy notify / Claude Code).
 */

export type AgentId = "zcode" | "codex" | "codex-legacy" | "claude" | "opencode";

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
