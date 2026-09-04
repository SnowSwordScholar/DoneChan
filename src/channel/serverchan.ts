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

/**
 * Official SendKey shapes: SC3 `sctp<digits>t<random>`, Turbo `SCT<random>`.
 * The random tail is observed to include hyphens/underscores (e.g.
 * `sctp903ta-oxx2…`), so it is validated as RFC 3986 unreserved characters —
 * broad enough for real keys, but still rejects path/query injection (`/ ? &`
 * etc.) before the key is ever embedded into a URL.
 */
const SC3_KEY_RE = /^sctp\d+t[A-Za-z0-9_.~-]+$/u;
const TURBO_KEY_RE = /^SCT[A-Za-z0-9_.~-]+$/u;

/** True when the key matches the official SendKey format (either generation). */
export function isValidSendKey(sendKey: string): boolean {
  return SC3_KEY_RE.test(sendKey) || TURBO_KEY_RE.test(sendKey);
}

/** Extract the numeric uid from an `sctp{uid}t{rand}` SendKey. */
export function uidFromSendKey(sendKey: string): string | null {
  const match = /^sctp(\d+)t/.exec(sendKey);
  return match ? match[1]! : null;
}

/** Build the push endpoint for a SendKey, routing SC3 vs Turbo by prefix. */
export function endpointFor(sendKey: string): string | null {
  if (SC3_KEY_RE.test(sendKey)) {
    const uid = uidFromSendKey(sendKey);
    return uid ? `https://${uid}.push.ft07.com/send/${encodeURIComponent(sendKey)}.send` : null;
  }
  if (TURBO_KEY_RE.test(sendKey)) {
    return `https://sctapi.ftqq.com/${encodeURIComponent(sendKey)}.send`;
  }
  return null;
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
    // Network errors can embed the full request URL — and the URL carries the
    // SendKey. Strip it before surfacing anything.
    return { ok: false, message: redactSendKey(reason) };
  } finally {
    clearTimeout(timer);
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Remove SendKey material from an error message: the key itself, and any
 * URL that might carry it (fetch errors quote the full URL).
 */
function redactSendKey(message: string): string {
  return message
    .replace(/sctp\d+t[A-Za-z0-9_.~-]+/gu, "<sendkey>")
    .replace(/SCT[A-Za-z0-9_.~-]+/gu, "<sendkey>")
    .replace(/(https?:\/\/)[^\s"'`<>]+/giu, "$1<url>");
}
