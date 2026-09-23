import pLimit from "p-limit";
import type { HrCredentials } from "../config.js";
import { AuthError, HrValidationError, InputError, NotFoundError, UpstreamError } from "../errors.js";

export const USER_AGENT = "hiringroom-mcp/0.1.0";
const BASE_URL = "https://api.hiringroom.com/v0";
const BACKOFF_MS = [500, 2000];
const REFRESH_MARGIN_MS = 5 * 60_000;

export type Query = Record<string, string | number | undefined>;
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface HrGetOptions {
  timeoutMs?: number;
  retries?: number;
}

export interface HrBinary {
  contentType: string;
  bytes: Buffer;
}

export interface HrLike {
  get<T = any>(path: string, query?: Query, opts?: HrGetOptions): Promise<T>;
  getBinary(path: string, maxBytes: number): Promise<HrBinary>;
}

export interface HrClientOptions {
  credentials: HrCredentials;
  concurrency: number;
  timeoutMs: number;
  fetch?: FetchLike;
  baseUrl?: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

async function readMessages(res: Response): Promise<string[]> {
  try {
    const body = (await res.json()) as { message?: string; errors?: unknown };
    if (Array.isArray(body.errors)) {
      const msgs = body.errors.map((e) => (e as { message?: string }).message).filter((m): m is string => !!m);
      if (msgs.length) return msgs;
    }
    const nested = (body.errors as { message?: string } | undefined)?.message;
    if (nested) return [nested];
    if (body.message) return [body.message];
  } catch {
    // fall through
  }
  return [`HTTP ${res.status}`];
}

function retryAfterMs(res: Response): number {
  const s = Number(res.headers.get("Retry-After"));
  return Number.isFinite(s) && s > 0 ? s * 1000 : 5000;
}

export class HrClient implements HrLike {
  private token?: string;
  private expiresAt = 0;
  private loginInFlight?: Promise<string>;
  private readonly limit: ReturnType<typeof pLimit>;
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly opts: HrClientOptions) {
    this.limit = pLimit(opts.concurrency);
    this.fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init));
    this.baseUrl = opts.baseUrl ?? BASE_URL;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? Date.now;
  }

  get<T = any>(path: string, query: Query = {}, opts: HrGetOptions = {}): Promise<T> {
    return this.request(path, query, opts, async (res) => {
      const text = await res.text();
      if (!text.trim()) return {} as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new UpstreamError(`respuesta no JSON de HiringRoom en ${path}`);
      }
    });
  }

  getBinary(path: string, maxBytes: number): Promise<HrBinary> {
    return this.request(path, {}, {}, async (res) => {
      const tooBig = () => new InputError(`el archivo supera el máximo de ${Math.round(maxBytes / 1024 / 1024)} MB`);
      if (Number(res.headers.get("Content-Length") ?? 0) > maxBytes) throw tooBig();
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length > maxBytes) throw tooBig();
      return { contentType: res.headers.get("Content-Type") ?? "", bytes };
    });
  }

  private headers(token?: string): Record<string, string> {
    const h: Record<string, string> = { "User-Agent": USER_AGENT, Accept: "application/json" };
    if (token) h.token = token;
    return h;
  }

  private send(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    return this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  }

  private async login(): Promise<string> {
    const { credentials: c, timeoutMs } = this.opts;
    let res: Response;
    try {
      res = await this.send(
        `${this.baseUrl}/authenticate/login/users`,
        {
          method: "POST",
          headers: { ...this.headers(), "Content-Type": "application/json" },
          body: JSON.stringify({
            grand_type: "password",
            client_id: c.clientId,
            client_secret: c.clientSecret,
            username: c.username,
            password: c.password,
          }),
        },
        timeoutMs,
      );
    } catch {
      throw new UpstreamError("sin respuesta de HiringRoom al hacer login");
    }
    if (res.status >= 500) throw new UpstreamError("HiringRoom no responde al hacer login");
    if (!res.ok) throw new AuthError(`login rechazado por HiringRoom (HTTP ${res.status})`);
    let body: { token?: string; expiresIn?: number };
    try {
      body = (await res.json()) as { token?: string; expiresIn?: number };
    } catch {
      throw new UpstreamError("respuesta no JSON de HiringRoom al hacer login");
    }
    if (!body.token) throw new AuthError("login de HiringRoom sin token");
    this.token = body.token;
    this.expiresAt = this.now() + (body.expiresIn ?? 3600) * 1000;
    return body.token;
  }

  private getToken(force = false): Promise<string> {
    if (!force && this.token && this.now() < this.expiresAt - REFRESH_MARGIN_MS) return Promise.resolve(this.token);
    this.loginInFlight ??= this.login().finally(() => {
      this.loginInFlight = undefined;
    });
    return this.loginInFlight;
  }

  private buildUrl(path: string, query: Query): string {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== "") qs.set(k, String(v));
    const s = qs.toString();
    return `${this.baseUrl}${path}${s ? `?${s}` : ""}`;
  }

  private request<T>(path: string, query: Query, opts: HrGetOptions, parse: (res: Response) => Promise<T>): Promise<T> {
    return this.limit(async () => {
      const url = this.buildUrl(path, query);
      const retries = opts.retries ?? BACKOFF_MS.length;
      const timeoutMs = opts.timeoutMs ?? this.opts.timeoutMs;
      let reauthed = false;
      let rateLimited = false;
      for (let attempt = 0; ; attempt++) {
        const token = await this.getToken();
        let res: Response;
        try {
          res = await this.send(url, { method: "GET", headers: this.headers(token) }, timeoutMs);
        } catch {
          if (attempt < retries) {
            await this.sleep(BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]);
            continue;
          }
          throw new UpstreamError(`sin respuesta de HiringRoom en ${path}`);
        }
        if (res.status === 401) {
          if (!reauthed) {
            reauthed = true;
            await this.getToken(true);
            attempt--;
            continue;
          }
          throw new AuthError("HiringRoom rechazó el token");
        }
        if (res.status === 404) throw new NotFoundError(path);
        if (res.status === 400 || res.status === 422) throw new HrValidationError(await readMessages(res));
        if (res.status === 429) {
          if (!rateLimited) {
            rateLimited = true;
            await this.sleep(retryAfterMs(res));
            attempt--;
            continue;
          }
          throw new UpstreamError("HiringRoom está limitando la tasa de pedidos");
        }
        if (res.status >= 500) {
          if (attempt < retries) {
            await this.sleep(BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]);
            continue;
          }
          throw new UpstreamError(`HiringRoom respondió ${res.status} en ${path}`);
        }
        if (!res.ok) throw new UpstreamError(`HiringRoom respondió ${res.status} en ${path}`);
        return parse(res);
      }
    });
  }
}
