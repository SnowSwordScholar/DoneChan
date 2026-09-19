import type { DoneEvent, Notification } from "../agent/types.js";
import { extractMarker } from "./marker.js";
import { buildTemplate, buildWaiting } from "./template.js";

/**
 * Build the notification content for an event: marker first (only when the
 * marker protocol is switched on), template fallback otherwise.
 *
 * `markerEnabled` defaults to false, matching the product default: the marker
 * costs the model output tokens on every completion, and the reply itself
 * already carries the content that ServerChan renders. The template path still
 * strips marker-shaped text either way — a stray marker must never reach the
 * phone, whether or not the protocol is on.
 */
export function compose(event: DoneEvent, markerEnabled = false): Notification {
  // Waiting notifications are built from the tool call that blocks on the
  // human, never from a marker in model output.
  if (event.kind === "waiting" && event.waiting) return buildWaiting(event);

  const marker = markerEnabled && event.lastAssistantMessage
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
