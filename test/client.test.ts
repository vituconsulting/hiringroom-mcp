import { describe, expect, it } from "vitest";
import { AuthError, HrValidationError, InputError, NotFoundError, UpstreamError } from "../src/errors.js";
import { HrClient, USER_AGENT, type FetchLike } from "../src/hr/client.js";

const creds = { clientId: "cid", clientSecret: "csecret", username: "api@x.com", password: "hunter2" };

type Step = Response | Error | (() => Response | Promise<Response>);
interface Call { url: string; init: RequestInit }

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}
const LOGIN = () => json({ token: "tok", expiresIn: 86400, tokenType: "bearer", refreshToken: "r" });

/** Login requests always succeed with LOGIN unless `loginSteps` is given; other requests consume `steps` in order. */
function fake(steps: Step[], loginSteps: Step[] = []) {
  const calls: Call[] = [];
  const logins: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    const isLogin = url.endsWith("/authenticate/login/users");
    (isLogin ? logins : calls).push({ url, init });
    const step = isLogin ? (loginSteps.shift() ?? LOGIN) : steps.shift();
    if (!step) throw new Error(`unexpected request ${url}`);
    if (step instanceof Error) throw step;
    return typeof step === "function" ? step() : step;
  };
  return { fetch, calls, logins };
}

function client(f: FetchLike, extra: Partial<ConstructorParameters<typeof HrClient>[0]> = {}) {
  const sleeps: number[] = [];
  const c = new HrClient({
    credentials: creds, concurrency: 5, timeoutMs: 1000, fetch: f,
    sleep: async (ms) => { sleeps.push(ms); }, ...extra,
  });
  return { c, sleeps };
}

describe("HrClient", () => {
  it("logs in once and sends token + user agent on GETs", async () => {
    const f = fake([json({ a: 1 }), json({ b: 2 })]);
    const { c } = client(f.fetch);
    expect(await c.get("/x", { page: 0, empty: undefined })).toEqual({ a: 1 });
    expect(await c.get("/y")).toEqual({ b: 2 });
    expect(f.logins).toHaveLength(1);
    expect(JSON.parse(String(f.logins[0].init.body))).toEqual({
      grand_type: "password", client_id: "cid", client_secret: "csecret", username: "api@x.com", password: "hunter2",
    });
    const h = f.calls[0].init.headers as Record<string, string>;
    expect(h.token).toBe("tok");
    expect(h["User-Agent"]).toBe(USER_AGENT);
    expect(f.calls[0].url).toBe("https://api.hiringroom.com/v0/x?page=0");
    expect(f.calls.every((k) => k.init.method === "GET")).toBe(true);
  });

  it("re-logs in once on 401, then gives up with AuthError", async () => {
    const ok = fake([json({}, 401), json({ ok: true })]);
    expect(await client(ok.fetch).c.get("/x")).toEqual({ ok: true });
    expect(ok.logins).toHaveLength(2);

    const bad = fake([json({}, 401), json({}, 401)]);
    await expect(client(bad.fetch).c.get("/x")).rejects.toBeInstanceOf(AuthError);
  });

  it("maps a rejected login to AuthError without leaking the password", async () => {
    const f = fake([], [json({ message: "Authentication Error" }, 401)]);
    const err = await client(f.fetch).c.get("/x").catch((e) => e);
    expect(err).toBeInstanceOf(AuthError);
    expect(String(err.message)).not.toContain("hunter2");
  });

  it("retries 5xx and network errors with backoff", async () => {
    const f = fake([json({}, 503), new TypeError("fetch failed"), json({ ok: 1 })]);
    const { c, sleeps } = client(f.fetch);
    expect(await c.get("/x")).toEqual({ ok: 1 });
    expect(sleeps).toEqual([500, 2000]);

    const g = fake([json({}, 500), json({}, 500), json({}, 500)]);
    await expect(client(g.fetch).c.get("/x")).rejects.toBeInstanceOf(UpstreamError);
  });

  it("honors retries: 0", async () => {
    const f = fake([Object.assign(new Error("t"), { name: "TimeoutError" })]);
    await expect(client(f.fetch).c.get("/x", {}, { retries: 0 })).rejects.toBeInstanceOf(UpstreamError);
  });

  it("waits Retry-After on 429 and retries once", async () => {
    const f = fake([json({}, 429, { "Retry-After": "1" }), json({ ok: 1 })]);
    const { c, sleeps } = client(f.fetch);
    expect(await c.get("/x")).toEqual({ ok: 1 });
    expect(sleeps).toEqual([1000]);
  });

  it("maps 404 and 422", async () => {
    const f = fake([
      json({ message: "404 Not Found" }, 404),
      json({ message: "Validation Error", errors: [{ field: "pageSize", message: "bad size" }] }, 422),
      json({ message: "Validation Error", errors: { message: "no reports" } }, 422),
    ]);
    const { c } = client(f.fetch);
    await expect(c.get("/a")).rejects.toBeInstanceOf(NotFoundError);
    await expect(c.get("/b")).rejects.toMatchObject({ messages: ["bad size"] });
    const err = await c.get("/c").catch((e) => e);
    expect(err).toBeInstanceOf(HrValidationError);
    expect(err.messages).toEqual(["no reports"]);
  });

  it("accepts non-200 success codes and empty bodies", async () => {
    const f = fake([json({ result: [] }, 202), new Response(null, { status: 204 })]);
    const { c } = client(f.fetch);
    expect(await c.get("/n")).toEqual({ result: [] });
    expect(await c.get("/e")).toEqual({});
  });

  it("re-logs in when the token is about to expire", async () => {
    let t = 0;
    const f = fake([json({}), json({})]);
    const { c } = client(f.fetch, { now: () => t });
    await c.get("/x");
    t = 86400_000 - 60_000; // 1 minute before expiry
    await c.get("/y");
    expect(f.logins).toHaveLength(2);
  });

  it("caps concurrency", async () => {
    let inFlight = 0;
    let max = 0;
    const fetch: FetchLike = async (url) => {
      if (url.endsWith("/authenticate/login/users")) return LOGIN();
      inFlight++;
      max = Math.max(max, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
      return json({});
    };
    const { c } = client(fetch, { concurrency: 2 });
    await Promise.all([1, 2, 3, 4, 5].map((i) => c.get(`/p${i}`)));
    expect(max).toBeLessThanOrEqual(2);
  });

  it("downloads binaries and enforces the size cap", async () => {
    const pdf = Buffer.from("%PDF-1.4 hello");
    const f = fake([
      new Response(pdf, { status: 200, headers: { "Content-Type": "application/pdf" } }),
      new Response(pdf, { status: 200, headers: { "Content-Type": "application/pdf" } }),
    ]);
    const { c } = client(f.fetch);
    const bin = await c.getBinary("/f", 1000);
    expect(bin.contentType).toBe("application/pdf");
    expect(bin.bytes.equals(pdf)).toBe(true);
    await expect(c.getBinary("/f", 5)).rejects.toBeInstanceOf(InputError);
  });

  it("exposes no write methods", () => {
    const names = Object.getOwnPropertyNames(HrClient.prototype);
    expect(names.filter((n) => /post|put|patch|delete/i.test(n))).toEqual([]);
  });
});
