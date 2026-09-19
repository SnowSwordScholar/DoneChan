/**
 * DoneChan's native plugin for DeepSeek Harness.
 *
 * Why a plugin instead of the shipped `dsh-hooks-claude-code` bridge: the
 * Claude Code `Stop` payload the bridge emits carries no assistant reply (it
 * omits `last_assistant_message` and always reports an empty `transcript_path`),
 * so every completion push degraded to the "no reply content" template. A
 * native plugin reaches the live session through the harness API instead, which
 * costs the model nothing — the text is already there, the plugin only reads it.
 *
 * Two notifications are produced:
 *   - `agent/turn-stopping`  → the turn ended; push the assistant's own words.
 *   - `tools/pre-execute`    → a tool that parks the run on the human
 *                              (`ask_user_question`, `exit_plan_mode`); push the
 *                              question verbatim, before the wait begins.
 *
 * Both hand the payload to the `donechan` CLI over stdin and return immediately,
 * so the agent loop is never blocked by a push.
 *
 * @module donechan-dsh
 */
import { spawn } from "node:child_process";

/** Plugin identity for the DSH loader. */
export const name = "donechan";

/** Tools whose execution *is* the wait: the run is parked until the human answers. */
const WAITING_TOOLS = ["ask_user_question", "exit_plan_mode"];

/** Concatenate the text blocks of one assistant message, ignoring reasoning/tool blocks. */
function textFromContent(content) {
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const block of content) {
    if (block && block.type === "text" && typeof block.text === "string") out += block.text;
  }
  return out;
}

/**
 * The newest text-bearing assistant message in the session's log.
 *
 * `session.snapshotEvents()` is the live Session's own append-only log — cached
 * until the next append, and unlike the persisted artifact it needs no decoding
 * and no knowledge of the on-disk format.
 */
function lastAssistantText(session) {
  let events;
  try {
    events = session.snapshotEvents();
  } catch {
    return null;
  }
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (!event || event.type !== "assistant/message") continue;
    const text = textFromContent(event.data?.message?.content);
    if (text.trim().length > 0) return text;
  }
  return null;
}

/** The workspace the agent is working in, best-effort. */
function cwdOf(session) {
  const cwd = session?.header?.cwd;
  return typeof cwd === "string" && cwd.length > 0 ? cwd : process.cwd();
}

export function apply(ctx, config) {
  const cliPath = config?.cliPath;
  if (typeof cliPath !== "string" || cliPath.length === 0) {
    ctx.logger.warn("donechan: `cliPath` is required in the plugin config; notifications are disabled");
    return;
  }

  /** Hand one payload to the CLI. Never throws, never blocks the caller. */
  function send(payload) {
    try {
      const child = spawn(process.execPath, [cliPath, "hook", "--agent", "dsh"], {
        stdio: ["pipe", "ignore", "ignore"],
        windowsHide: true,
      });
      child.on("error", (error) => {
        ctx.logger.warn(`donechan: could not start ${cliPath}: ${String(error)}`);
      });
      child.stdin.on("error", () => {
        /* the CLI exiting early is not our problem */
      });
      child.stdin.end(JSON.stringify(payload));
      child.unref();
    } catch (error) {
      ctx.logger.warn(`donechan: notification failed: ${String(error)}`);
    }
  }

  // The turn ended: push what the agent said, verbatim.
  ctx.on("agent/turn-stopping", ({ agent }) => {
    if (!agent) return;
    const session = agent.session;
    send({
      hook_event_name: "Stop",
      source_agent: "dsh",
      session_id: session.id,
      transcript_path: "",
      cwd: cwdOf(session),
      stop_hook_active: false,
      last_assistant_message: lastAssistantText(session),
    });
  });

  // A tool that parks the run on the human: push the question itself, at the
  // moment it is asked rather than after it is answered.
  ctx.on("tools/pre-execute", (exec, next) => {
    if (exec && WAITING_TOOLS.includes(exec.name) && exec.agent) {
      send({
        hook_event_name: "PreToolUse",
        source_agent: "dsh",
        session_id: exec.agent.session.id,
        cwd: cwdOf(exec.agent.session),
        tool_name: exec.name,
        tool_input: exec.arguments,
      });
    }
    // Observer only: the decision belongs to the rest of the waterfall.
    return next();
  });
}
