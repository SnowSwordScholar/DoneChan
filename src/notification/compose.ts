import type { DoneEvent, Notification } from "../agent/types.js";
import { extractMarker } from "./marker.js";
import { buildTemplate, buildWaiting } from "./template.js";

/** Build the notification content for an event: marker first, template fallback. */
export function compose(event: DoneEvent): Notification {
  // Waiting notifications are built from the tool call that blocks on the
  // human, never from a marker in model output.
  if (event.kind === "waiting" && event.waiting) return buildWaiting(event);

  const marker = event.lastAssistantMessage
    ? extractMarker(event.lastAssistantMessage, { allowCodexHidden: event.agent === "codex" || event.agent === "codex-legacy" })
    : null;
  if (marker) {
    return {
      title: marker.title,
      body: marker.desp ?? marker.title,
      short: marker.short,
      tags: marker.tags,
      source: "marker",
    };
  }
  return buildTemplate(event);
}
