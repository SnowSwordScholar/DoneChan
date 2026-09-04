import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { endpointFor, isValidSendKey, push, setMinIntervalMs, uidFromSendKey } from "../src/channel/serverchan.js";

describe("sendkey handling", () => {
  beforeEach(() => setMinIntervalMs(0));
  it("extracts uid from SC3 keys", () => {
    expect(uidFromSendKey("sctp12345tAbCdEf")).toBe("12345");
    expect(uidFromSendKey("SCT12345ABCDE")).toBeNull();
  });
  it("routes SC3 vs Turbo endpoints", () => {
    expect(endpointFor("sctp12345tAbCdEf")).toBe("https://12345.push.ft07.com/send/sctp12345tAbCdEf.send");
    expect(endpointFor("SCT12345ABCDE")).toBe("https://sctapi.ftqq.com/SCT12345ABCDE.send");
    expect(endpointFor("bogus")).toBeNull();
  });
  it("validates key shapes", () => {
    expect(isValidSendKey("sctp1tx")).toBe(true);
    expect(isValidSendKey("SCTxxx")).toBe(true);
    expect(isValidSendKey("hello")).toBe(false);
    expect(isValidSendKey("")).toBe(false);
    expect(isValidSendKey("SCT/foo?x=1")).toBe(false);
  });
});

describe("push", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns ok on code 0", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ code: 0, message: "ok", data: { pushid: "p1" } }), { status: 200 })),
    );
    const r = await push("sctp12345tAbCdEf", { title: "t" });
    expect(r.ok).toBe(true);
    expect(r.pushId).toBe("p1");
  });

  it("reports server rejection with message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ code: 1024, message: "内容重复" }), { status: 200 })),
    );
    const r = await push("sctp12345tAbCdEf", { title: "t" });
    expect(r.ok).toBe(false);
    expect(r.message).toContain("内容重复");
  });

  it("reports non-JSON responses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>oops</html>", { status: 500 })));
    const r = await push("sctp12345tAbCdEf", { title: "t" });
    expect(r.ok).toBe(false);
    expect(r.message).toContain("non-JSON");
  });

  it("reports timeout", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          }),
      ),
    );
    const r = await push("sctp12345tAbCdEf", { title: "t" }, 30);
    expect(r.ok).toBe(false);
    expect(r.message).toBe("timeout");
  });

  it("sends title/desp/short/tags as JSON body", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ code: 0 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await push("sctp12345tAbCdEf", { title: "T", desp: "D", short: "S", tags: "a|b" });
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toContain("12345.push.ft07.com");
    expect(JSON.parse(String(init.body))).toEqual({ title: "T", desp: "D", short: "S", tags: "a|b" });
  });

  it("never leaks the sendkey even when the error embeds the full request URL", async () => {
    const key = "sctp12345tSuperSecretValue99";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error(
          `request to https://12345.push.ft07.com/send/${key}.send failed: ECONNRESET`,
        );
      }),
    );
    const r = await push(key, { title: "t" });
    expect(r.ok).toBe(false);
    expect(r.message).not.toContain("SuperSecretValue99");
    expect(r.message).not.toContain("push.ft07.com/send");
    expect(r.message).toContain("<url>");
    expect(r.message).toContain("<sendkey>");
  });

  it("rejects sendkeys that do not match the official format", async () => {
    // No fetch stub: push must bail out before any network call.
    for (const bad of ["SCT/foo?x=1", "sctpabcTx", "sctp12345t", "hello", "SCT with space", "sctp12345tбуc"]) {
      const r = await push(bad, { title: "t" });
      expect(r.ok, bad).toBe(false);
      expect(r.message).toContain("invalid sendkey format");
    }
  });

  it("accepts the documented official key shapes", async () => {
    expect(isValidSendKey("sctp12345tAbCdEfGhIjKlMnOpQrStUv")).toBe(true);
    expect(isValidSendKey("SCT12345ABCDE")).toBe(true);
    // Real-world SC3 keys include hyphens/underscores in the random tail.
    expect(isValidSendKey("sctp903ta-oxx2B_c9-d3")).toBe(true);
    expect(isValidSendKey("sctp12345tбуc")).toBe(false);
    expect(isValidSendKey("SCT/foo?x=1")).toBe(false);
    expect(isValidSendKey("sctp12345t/../../etc")).toBe(false);
    expect(isValidSendKey("sctp12345t?x=1")).toBe(false);
  });
});
