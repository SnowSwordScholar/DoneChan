/**
 * Claude Code Stop payloads carry no reply text — only a `transcript_path`
 * pointing at the session's JSONL transcript. Recover the final assistant
 * reply (and with it the donechan marker) by scanning the transcript
 * backwards for the last main-chain assistant message containing text.
 *
 * Skipped entries: sidechain (subagent) turns, API-error placeholders, and
 * assistant entries whose content has no text blocks (thinking/tool_use only,
 * or tool rounds the transcript recorded after the final text reply).
 */

import { closeSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";

const MAX_TRANSCRIPT_BYTES = 4 * 1024 * 1024;

interface TranscriptEntry {
  type?: unknown;
  isSidechain?: unknown;
  isApiErrorMessage?: unknown;
  message?: unknown;
}

interface TextBlock {
  type?: unknown;
  text?: unknown;
}

/** Concatenated text blocks of one message content, or null when it has none. */
function textFromContent(content: unknown): string | null {
  if (typeof content === "string") return content.trim() ? content : null;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content as TextBlock[]) {
    if (typeof block === "object" && block !== null && block.type === "text" && typeof block.text === "string" && block.text.trim()) {
      parts.push(block.text);
    }
  }
  return parts.length > 0 ? parts.join("\n\n") : null;
}

/** Pure core of the scan, over the raw JSONL text. */
export function extractLastAssistantText(jsonl: string): string | null {
  const lines = jsonl.split(/\r?\n/u);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line) continue;
    let entry: TranscriptEntry;
    try {
      entry = JSON.parse(line) as TranscriptEntry;
    } catch {
      continue; // partial/corrupt line — skip
    }
    if (entry.type !== "assistant") continue;
    if (entry.isSidechain === true || entry.isApiErrorMessage === true) continue;
    const content = (entry.message as { content?: unknown } | undefined)?.content;
    const text = textFromContent(content);
    if (text) return text;
  }
  return null;
}

/** Read a transcript file and return the last main-chain assistant text, or null. */
export function readLastAssistantText(transcriptPath: string): string | null {
  try {
    const fd = openSync(transcriptPath, "r");
    try {
      const size = fstatSync(fd).size;
      if (size <= MAX_TRANSCRIPT_BYTES) return extractLastAssistantText(readFileSync(transcriptPath, "utf8"));
      // The marker and final response are at the end. Reading a bounded tail
      // avoids loading an unbounded session transcript into the hook process;
      // a partial first JSONL line is harmless because the scanner skips it.
      const start = size - MAX_TRANSCRIPT_BYTES;
      const buffer = Buffer.alloc(MAX_TRANSCRIPT_BYTES);
      readSync(fd, buffer, 0, buffer.length, start);
      return extractLastAssistantText(buffer.toString("utf8"));
    } finally {
      closeSync(fd);
    }
  } catch {
    return null; // unreadable/missing transcript: degrade to the template
  }
}
