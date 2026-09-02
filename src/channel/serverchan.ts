/**
 * ServerChan³ push channel.
 *
 * Endpoint: https://{uid}.push.ft07.com/send/{sendkey}.send
 * SendKey formats: `sctp{uid}t{rand}` → ServerChan³ (push.ft07.com);
 * `SCT...` → legacy Turbo (sctapi.ftqq.com/{sendkey}.send).
 * Success: JSON body with code === 0.
 */

export interface PushPayload {
  title: string;
  desp?: string;
  short?: string;
  tags?: string;
}

export interface PushResult {
  ok: boolean;
  /** Human-readable outcome, safe to log (never contains the key). */
  message: string;
  /** pushid from the server on success, when present. */
  pushId?: string;
}

const DEFAULT_TIMEOUT_MS = 5000;
const MIN_INTERVAL_MS = 1100;

/** Overridable for tests. */
let minIntervalMs = MIN_INTERVAL_MS;

export function setMinIntervalMs(ms: number): void {
  minIntervalMs = ms;
}

let lastSendAt = 0;

/** Extract the numeric uid from an `sctp{uid}t...` SendKey. */
export function uidFromSendKey(sendKey: string): string | null {
  const match = /^sctp(\d+)t/.exec(sendKey);
  return match ? match[1]! : null;
}

/** Build the push endpoint for a SendKey, routing SC3 vs Turbo by prefix. */
export function endpointFor(sendKey: string): string | null {
  if (sendKey.startsWith("sctp")) {
    const uid = uidFromSendKey(sendKey);
    return uid ? `https://${uid}.push.ft07.com/send/${sendKey}.send` : null;
  }
  if (sendKey.startsWith("SCT")) {
    return `https://sctapi.ftqq.com/${sendKey}.send`;
  }
  return null;
}

/** True when the key looks like a ServerChan SendKey (either generation). */
export function isValidSendKey(sendKey: string): boolean {
  return /^(sctp\d+t|SCT)/.test(sendKey);
}

/** Minimal client-side pacing; ServerChan rejects rapid identical content. */
function pace(): Promise<void> {
  const now = Date.now();
  const wait = lastSendAt + minIntervalMs - now;
  lastSendAt = Math.max(now, lastSendAt + minIntervalMs);
  return wait > 0 ? new Promise((resolve) => setTimeout(resolve, wait)) : Promise.resolve();
}

export async function push(
  sendKey: string,
  payload: PushPayload,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<PushResult> {
  const endpoint = endpointFor(sendKey);
  if (!endpoint) {
    return { ok: false, message: "invalid sendkey format (expected sctp...t... or SCT...)" };
  }

  await pace();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json;charset=utf-8" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const raw = await response.text();
    let json: { code?: unknown; errno?: unknown; message?: unknown; data?: { pushid?: unknown } } = {};
    try {
      json = JSON.parse(raw);
    } catch {
      return { ok: false, message: `non-JSON response (HTTP ${response.status})` };
    }
    const code = json.code ?? json.errno;
    if (code === 0) {
      const pushId = typeof json.data?.pushid === "string" || typeof json.data?.pushid === "number"
        ? String(json.data.pushid)
        : undefined;
      return { ok: true, message: "pushed", pushId };
    }
    return { ok: false, message: `server rejected: ${String(json.message ?? raw.slice(0, 200))}` };
  } catch (err) {
    const reason = err instanceof Error && err.name === "AbortError" ? "timeout" : describeError(err);
    return { ok: false, message: reason };
  } finally {
    clearTimeout(timer);
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
