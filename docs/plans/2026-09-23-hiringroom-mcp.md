# HiringRoom MCP (MVP) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local stdio MCP server that lets Claude Code query Patagonia Resources' HiringRoom account (vacancies, postulants, CVs, reports, scoped cross-search) read-only.

**Architecture:** Node 22 + TypeScript ESM. A GET-only HiringRoom client (`src/hr/`) handles login, retries and concurrency; pure modules shape payloads (`src/shape/`), score candidates (`src/search/`) and extract CV text (`src/cv/`); each tool lives in `src/tools/` and is registered through one wrapper that validates, trims, audits and maps errors. Transport is stdio only; nothing in `hr/`, `shape/`, `search/`, `cv/`, `tools/` imports the transport.

**Tech Stack:** Node 22, TypeScript 5, `@modelcontextprotocol/sdk@^1.30`, `zod@^3.25`, `p-limit@^7`, `mammoth@^1.12`, `vitest@^3`, `tsx`, system `pdftotext` (poppler).

**Spec:** `docs/specs/2026-09-23-hiringroom-mcp-design.md` — read it before starting any task.

## Global Constraints

- Node `>=22`; ESM (`"type": "module"`); relative imports end in `.js`.
- HiringRoom base URL: `https://api.hiringroom.com/v0`. Auth: `POST /authenticate/login/users` with body keys `grand_type` (sic, value `"password"`), `client_id`, `client_secret`, `username`, `password`. Token goes in the `token` request header, never in the URL.
- Every request sends `User-Agent: hiringroom-mcp/0.1.0`.
- The HR client exposes only GET (plus login). No POST/PUT/PATCH/DELETE methods anywhere.
- Secrets file: env `HIRINGROOM_ENV_FILE`, default `~/.config/hiringroom-mcp/.env`, mode must be 600. Required keys: `HR_CLIENT_ID`, `HR_CLIENT_SECRET`, `HR_USERNAME`, `HR_PASSWORD`.
- Tool names, descriptions and user-facing messages in Spanish. Tool input dates are ISO `YYYY-MM-DD`, timezone `America/Argentina/Buenos_Aires` (fixed UTC-3).
- Limits (defaults): concurrency 5; request timeout 20 s; stats budget 10 s; cross-search max scanned 1000, CVs read top 30, budget 90 s; CV download 10 MB; CV text default 20,000 / max 60,000 chars; tool response ~25,000 bytes; catalog cache 1 h.
- Never return `genero` or `fotoPerfil`. `dni`, `cuil`, `fechaNacimiento` only from `ver_postulante` with `incluir_sensibles: true`.
- Secrets never appear in logs, errors or responses. Operational logs go to stderr only (stdout is the MCP protocol).
- Test fixtures are synthetic. Never commit real Patagonia data. `.env` is git-ignored.
- Commits: conventional messages, **no `Co-Authored-By` trailer**.

## Deviations from the spec (intentional)

- Spec §3.2 says "refresh via `/authenticate/login/refresh_token`". The plan re-logs in with the stored credentials instead (the refresh endpoint's body is undocumented; re-login is equivalent for a service user). Same observable behavior.
- Spec §9.1 lists `undici`; the plan uses Node 22's global `fetch` (which is undici) — one less dependency.
- Tools with `limite` take `10..100` (HiringRoom's `pageSize` minimum is 10).

## File map

```
package.json, tsconfig.json, tsconfig.build.json, vitest.config.ts, .env.example, README.md
src/
  index.ts              stdio entry: load config, check pdftotext, build ctx, connect
  config.ts             secrets file + limits
  errors.ts             InputError, AuthError, NotFoundError, HrValidationError, UpstreamError
  text.ts               normalize() for accent/case-insensitive matching
  log.ts                redact(), logError() → stderr
  audit.ts              JSONL audit with PII hashing + rotation; memoryAudit()
  hr/client.ts          HrClient (login, GET, getBinary, retries, concurrency)
  hr/dates.ts           ISO ↔ epoch ↔ DD-MM-YYYY, windows, ranges
  hr/paginate.ts        firstArray(), fetchAll()
  hr/catalog.ts         TtlCache, getPipelines(), stageName(), resolveStage()
  shape/common.ts       compact(), label(), personName(), place(), siNo(), num(), trimToSize()
  shape/vacancy.ts      vacancySummary(), vacancyDetail()
  shape/postulant.ts    aniosExperiencia(), postulantSummary(), postulantProfile()
  search/perfil.ts      scoreCandidate(), rank()
  cv/extract.ts         assertPdftotext(), detectKind(), extractText(), cleanText(), truncate()
  tools/context.ts      ToolContext, ToolResult types
  tools/define.ts       ToolDef, registerTool(), errorMessage(), orNotFound(), settle(), unwrap()
  tools/index.ts        ALL_TOOLS
  tools/catalogos.ts, buscar-vacantes.ts, ver-vacante.ts, buscar-postulantes.ts, ver-postulante.ts,
  tools/leer-cv.ts, buscar-por-perfil.ts, reporte-contrataciones.ts, reporte-movimientos-vacantes.ts,
  tools/postulaciones-por-dia.ts
  server.ts             createServer(ctx, audit)
test/
  fixtures.ts           synthetic raw payload builders
  helpers/harness.ts    FakeHr + in-memory MCP client
  helpers/pdf.ts        minimalPdf()
  *.test.ts
scripts/smoke.ts        manual read-only run against the real API (counts, timings, key names only)
```

---

### Task 1: Scaffold + config

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts`, `.env.example`, `src/errors.ts`, `src/config.ts`
- Test: `test/config.test.ts`

**Interfaces:**
- Produces:
  - `src/errors.ts`: `class InputError extends Error`, `class AuthError extends Error`, `class NotFoundError extends Error { path: string; constructor(path: string, message?: string) }`, `class HrValidationError extends Error { messages: string[]; constructor(messages: string[]) }`, `class UpstreamError extends Error`
  - `src/config.ts`: `class ConfigError extends Error`; `interface HrCredentials { clientId; clientSecret; username; password }`; `interface Limits { concurrency; requestTimeoutMs; statsBudgetMs; perfilMaxScan; perfilCvTop; perfilBudgetMs; cvMaxBytes; cvDefaultChars; cvMaxChars; responseMaxBytes; cacheTtlMs }` (all `number`); `const DEFAULT_LIMITS: Limits`; `interface Config { hr: HrCredentials; limits: Limits; auditDir: string }`; `parseEnvFile(text: string): Record<string, string>`; `defaultEnvFile(env?): string`; `loadConfig(env?: NodeJS.ProcessEnv): Config`

- [ ] **Step 1: Create the project files**

`package.json`:
```json
{
  "name": "hiringroom-mcp",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "bin": { "hiringroom-mcp": "dist/index.js" },
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "smoke": "tsx scripts/smoke.ts"
  }
}
```

Then install:
```bash
npm i @modelcontextprotocol/sdk@^1.30 zod@^3.25 p-limit@^7 mammoth@^1.12
npm i -D typescript@^5 vitest@^3 tsx@^4 @types/node@^22
```
If the installed `@modelcontextprotocol/sdk` major is not 1, stop and report.

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "outDir": "dist",
    "rootDir": "."
  },
  "include": ["src", "test", "scripts", "vitest.config.ts"]
}
```

`tsconfig.build.json`:
```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src"]
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({ test: { include: ["test/**/*.test.ts"], testTimeout: 15_000 } });
```

`.env.example`:
```
# Copy to ~/.config/hiringroom-mcp/.env and chmod 600
HR_CLIENT_ID=
HR_CLIENT_SECRET=
HR_USERNAME=
HR_PASSWORD=
```

`src/errors.ts`:
```ts
/** Bad tool input; the message is shown to Claude as-is. */
export class InputError extends Error {
  override name = "InputError";
}

export class AuthError extends Error {
  override name = "AuthError";
}

export class NotFoundError extends Error {
  override name = "NotFoundError";
  constructor(
    public path: string,
    message = "no existe el recurso solicitado en HiringRoom",
  ) {
    super(message);
  }
}

export class HrValidationError extends Error {
  override name = "HrValidationError";
  constructor(public messages: string[]) {
    super(messages.join("; "));
  }
}

export class UpstreamError extends Error {
  override name = "UpstreamError";
}
```

- [ ] **Step 2: Write the failing tests**

`test/config.test.ts`:
```ts
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, DEFAULT_LIMITS, loadConfig, parseEnvFile } from "../src/config.js";

const GOOD = "HR_CLIENT_ID=cid\nHR_CLIENT_SECRET=s3cr3t\nHR_USERNAME=api@x.com\nHR_PASSWORD='p4ss word'\n";

function envFile(content: string, mode = 0o600): string {
  const dir = mkdtempSync(join(tmpdir(), "hrcfg-"));
  const file = join(dir, ".env");
  writeFileSync(file, content);
  chmodSync(file, mode);
  return file;
}

describe("parseEnvFile", () => {
  it("parses keys, strips quotes, skips comments and blanks", () => {
    expect(parseEnvFile("# c\n\nA=1\nB=\"two\"\nC='three'\n D = x \n")).toEqual({ A: "1", B: "two", C: "three", D: "x" });
  });
});

describe("loadConfig", () => {
  it("loads credentials and default limits", () => {
    const cfg = loadConfig({ HIRINGROOM_ENV_FILE: envFile(GOOD), HR_MCP_AUDIT_DIR: "/tmp/a" });
    expect(cfg.hr).toEqual({ clientId: "cid", clientSecret: "s3cr3t", username: "api@x.com", password: "p4ss word" });
    expect(cfg.limits).toEqual(DEFAULT_LIMITS);
    expect(cfg.auditDir).toBe("/tmp/a");
  });

  it("fails when the file is missing", () => {
    expect(() => loadConfig({ HIRINGROOM_ENV_FILE: "/nope/.env" })).toThrow(/no se encontró/);
  });

  it("fails when the file is readable by others", () => {
    expect(() => loadConfig({ HIRINGROOM_ENV_FILE: envFile(GOOD, 0o644) })).toThrow(/600/);
  });

  it("names missing keys without leaking values", () => {
    const file = envFile("HR_CLIENT_ID=cid\nHR_CLIENT_SECRET=s3cr3t\n");
    let err: unknown;
    try {
      loadConfig({ HIRINGROOM_ENV_FILE: file });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toContain("HR_USERNAME");
    expect((err as Error).message).toContain("HR_PASSWORD");
    expect((err as Error).message).not.toContain("s3cr3t");
  });

  it("overrides limits from env and rejects bad values", () => {
    const file = envFile(GOOD);
    expect(loadConfig({ HIRINGROOM_ENV_FILE: file, HR_MCP_CONCURRENCY: "2" }).limits.concurrency).toBe(2);
    expect(() => loadConfig({ HIRINGROOM_ENV_FILE: file, HR_MCP_CONCURRENCY: "x" })).toThrow(/HR_MCP_CONCURRENCY/);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL — cannot resolve `../src/config.js`.

- [ ] **Step 4: Implement `src/config.ts`**

```ts
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export class ConfigError extends Error {
  override name = "ConfigError";
}

export interface HrCredentials {
  clientId: string;
  clientSecret: string;
  username: string;
  password: string;
}

export interface Limits {
  concurrency: number;
  requestTimeoutMs: number;
  statsBudgetMs: number;
  perfilMaxScan: number;
  perfilCvTop: number;
  perfilBudgetMs: number;
  cvMaxBytes: number;
  cvDefaultChars: number;
  cvMaxChars: number;
  responseMaxBytes: number;
  cacheTtlMs: number;
}

export const DEFAULT_LIMITS: Limits = {
  concurrency: 5,
  requestTimeoutMs: 20_000,
  statsBudgetMs: 10_000,
  perfilMaxScan: 1000,
  perfilCvTop: 30,
  perfilBudgetMs: 90_000,
  cvMaxBytes: 10 * 1024 * 1024,
  cvDefaultChars: 20_000,
  cvMaxChars: 60_000,
  responseMaxBytes: 25_000,
  cacheTtlMs: 3_600_000,
};

const LIMIT_ENV: Record<keyof Limits, string> = {
  concurrency: "HR_MCP_CONCURRENCY",
  requestTimeoutMs: "HR_MCP_REQUEST_TIMEOUT_MS",
  statsBudgetMs: "HR_MCP_STATS_BUDGET_MS",
  perfilMaxScan: "HR_MCP_PERFIL_MAX_SCAN",
  perfilCvTop: "HR_MCP_PERFIL_CV_TOP",
  perfilBudgetMs: "HR_MCP_PERFIL_BUDGET_MS",
  cvMaxBytes: "HR_MCP_CV_MAX_BYTES",
  cvDefaultChars: "HR_MCP_CV_DEFAULT_CHARS",
  cvMaxChars: "HR_MCP_CV_MAX_CHARS",
  responseMaxBytes: "HR_MCP_RESPONSE_MAX_BYTES",
  cacheTtlMs: "HR_MCP_CACHE_TTL_MS",
};

export interface Config {
  hr: HrCredentials;
  limits: Limits;
  auditDir: string;
}

const REQUIRED = ["HR_CLIENT_ID", "HR_CLIENT_SECRET", "HR_USERNAME", "HR_PASSWORD"] as const;

export function defaultEnvFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.HIRINGROOM_ENV_FILE ?? join(homedir(), ".config", "hiringroom-mcp", ".env");
}

export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i < 1) continue;
    let value = line.slice(i + 1).trim();
    const quoted = (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"));
    if (quoted && value.length >= 2) value = value.slice(1, -1);
    out[line.slice(0, i).trim()] = value;
  }
  return out;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const file = defaultEnvFile(env);
  let mode: number;
  try {
    mode = statSync(file).mode;
  } catch {
    throw new ConfigError(`no se encontró el archivo de secretos: ${file}`);
  }
  if ((mode & 0o077) !== 0) {
    throw new ConfigError(`permisos inseguros en ${file}: debe ser 600 (chmod 600 ${file})`);
  }
  const vars = parseEnvFile(readFileSync(file, "utf8"));
  const missing = REQUIRED.filter((k) => !vars[k]);
  if (missing.length) throw new ConfigError(`faltan claves en ${file}: ${missing.join(", ")}`);

  const limits: Limits = { ...DEFAULT_LIMITS };
  for (const key of Object.keys(LIMIT_ENV) as (keyof Limits)[]) {
    const raw = env[LIMIT_ENV[key]];
    if (raw === undefined) continue;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) throw new ConfigError(`${LIMIT_ENV[key]} debe ser un número positivo`);
    limits[key] = n;
  }

  return {
    hr: {
      clientId: vars.HR_CLIENT_ID,
      clientSecret: vars.HR_CLIENT_SECRET,
      username: vars.HR_USERNAME,
      password: vars.HR_PASSWORD,
    },
    limits,
    auditDir: env.HR_MCP_AUDIT_DIR ?? join(homedir(), ".local", "state", "hiringroom-mcp"),
  };
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run test/config.test.ts && npx tsc --noEmit`
Expected: 6 tests PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.json tsconfig.build.json vitest.config.ts .env.example src/errors.ts src/config.ts test/config.test.ts
git commit -m "feat: scaffold project and secrets/limits config"
```

---

### Task 2: Dates

**Files:**
- Create: `src/hr/dates.ts`
- Test: `test/dates.test.ts`

**Interfaces:**
- Consumes: `InputError` from `src/errors.ts`
- Produces: `assertIso(s: string): void`; `epochStart(iso: string): number`; `epochEnd(iso: string): number`; `toDmy(iso: string): string`; `addDays(iso: string, n: number): string`; `daysInclusive(desde: string, hasta: string): number`; `assertRange(desde: string, hasta: string, maxDays?: number): void`; `interface DateWindow { desde: string; hasta: string }`; `splitWindows(desde: string, hasta: string, maxDays: number): DateWindow[]`; `eachDay(desde: string, hasta: string): string[]`; `normalizeHrDate(v: unknown): string | undefined`

- [ ] **Step 1: Write the failing tests**

`test/dates.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { InputError } from "../src/errors.js";
import {
  addDays, assertIso, assertRange, daysInclusive, eachDay, epochEnd, epochStart, normalizeHrDate, splitWindows, toDmy,
} from "../src/hr/dates.js";

describe("dates", () => {
  it("validates ISO dates, including impossible days", () => {
    expect(() => assertIso("2026-09-23")).not.toThrow();
    expect(() => assertIso("23-09-2026")).toThrow(InputError);
    expect(() => assertIso("2026-02-30")).toThrow(InputError);
  });

  it("converts to Buenos Aires epoch bounds", () => {
    // 2026-09-23T00:00:00-03:00 == 2026-09-23T03:00:00Z
    expect(epochStart("2026-09-23")).toBe(Date.UTC(2026, 8, 23, 3) / 1000);
    expect(epochEnd("2026-09-23")).toBe(epochStart("2026-09-23") + 86399);
  });

  it("formats DD-MM-YYYY and does day math", () => {
    expect(toDmy("2026-09-03")).toBe("03-09-2026");
    expect(addDays("2026-02-27", 2)).toBe("2026-03-01");
    expect(daysInclusive("2026-09-01", "2026-09-30")).toBe(30);
  });

  it("checks ranges", () => {
    expect(() => assertRange("2026-09-10", "2026-09-01")).toThrow(/posterior/);
    expect(() => assertRange("2026-09-01", "2026-10-01", 30)).toThrow(/30 días/);
    expect(() => assertRange("2026-09-01", "2026-09-30", 30)).not.toThrow();
  });

  it("splits ranges into contiguous windows of at most maxDays", () => {
    expect(splitWindows("2026-07-01", "2026-08-15", 30)).toEqual([
      { desde: "2026-07-01", hasta: "2026-07-30" },
      { desde: "2026-07-31", hasta: "2026-08-15" },
    ]);
    expect(splitWindows("2026-09-01", "2026-09-01", 7)).toEqual([{ desde: "2026-09-01", hasta: "2026-09-01" }]);
  });

  it("lists each day", () => {
    expect(eachDay("2026-09-29", "2026-10-01")).toEqual(["2026-09-29", "2026-09-30", "2026-10-01"]);
  });

  it("normalizes HiringRoom dates", () => {
    expect(normalizeHrDate("23-09-2026")).toBe("2026-09-23");
    expect(normalizeHrDate("23/09/2026")).toBe("2026-09-23");
    expect(normalizeHrDate("2026-09-23T10:00:00Z")).toBe("2026-09-23");
    expect(normalizeHrDate(null)).toBeUndefined();
    expect(normalizeHrDate("")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/dates.test.ts`
Expected: FAIL — cannot resolve `../src/hr/dates.js`.

- [ ] **Step 3: Implement `src/hr/dates.ts`**

```ts
import { InputError } from "../errors.js";

// America/Argentina/Buenos_Aires has had no DST since 2009: fixed UTC-3.
const OFFSET = "-03:00";
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

export interface DateWindow {
  desde: string;
  hasta: string;
}

function utcMs(iso: string): number {
  return Date.parse(`${iso}T00:00:00Z`);
}

export function assertIso(s: string): void {
  const ok = ISO.test(s) && !Number.isNaN(utcMs(s)) && new Date(utcMs(s)).toISOString().slice(0, 10) === s;
  if (!ok) throw new InputError(`fecha inválida "${s}", usar YYYY-MM-DD`);
}

export function epochStart(iso: string): number {
  assertIso(iso);
  return Date.parse(`${iso}T00:00:00${OFFSET}`) / 1000;
}

export function epochEnd(iso: string): number {
  return epochStart(iso) + 86_399;
}

export function toDmy(iso: string): string {
  assertIso(iso);
  const [y, m, d] = iso.split("-");
  return `${d}-${m}-${y}`;
}

export function addDays(iso: string, n: number): string {
  return new Date(utcMs(iso) + n * DAY_MS).toISOString().slice(0, 10);
}

export function daysInclusive(desde: string, hasta: string): number {
  return Math.round((utcMs(hasta) - utcMs(desde)) / DAY_MS) + 1;
}

export function assertRange(desde: string, hasta: string, maxDays?: number): void {
  assertIso(desde);
  assertIso(hasta);
  if (desde > hasta) throw new InputError("`desde` no puede ser posterior a `hasta`");
  if (maxDays !== undefined && daysInclusive(desde, hasta) > maxDays) {
    throw new InputError(`el rango máximo es de ${maxDays} días`);
  }
}

export function splitWindows(desde: string, hasta: string, maxDays: number): DateWindow[] {
  assertRange(desde, hasta);
  const out: DateWindow[] = [];
  for (let start = desde; start <= hasta; ) {
    let end = addDays(start, maxDays - 1);
    if (end > hasta) end = hasta;
    out.push({ desde: start, hasta: end });
    start = addDays(end, 1);
  }
  return out;
}

export function eachDay(desde: string, hasta: string): string[] {
  assertRange(desde, hasta);
  const out: string[] = [];
  for (let d = desde; d <= hasta; d = addDays(d, 1)) out.push(d);
  return out;
}

export function normalizeHrDate(v: unknown): string | undefined {
  if (typeof v !== "string" || !v.trim()) return undefined;
  const s = v.trim();
  const dmy = /^(\d{2})[-/](\d{2})[-/](\d{4})/.exec(s);
  if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return s;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/dates.test.ts`
Expected: 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/hr/dates.ts test/dates.test.ts
git commit -m "feat: add date conversion and window splitting"
```

---

### Task 3: HiringRoom client

**Files:**
- Create: `src/hr/client.ts`
- Test: `test/client.test.ts`

**Interfaces:**
- Consumes: `HrCredentials` from `src/config.ts`; errors from `src/errors.ts`
- Produces:
  - `type Query = Record<string, string | number | undefined>`
  - `interface HrGetOptions { timeoutMs?: number; retries?: number }`
  - `interface HrBinary { contentType: string; bytes: Buffer }`
  - `interface HrLike { get<T = any>(path: string, query?: Query, opts?: HrGetOptions): Promise<T>; getBinary(path: string, maxBytes: number): Promise<HrBinary> }`
  - `type FetchLike = (url: string, init: RequestInit) => Promise<Response>`
  - `class HrClient implements HrLike` with `constructor(opts: { credentials: HrCredentials; concurrency: number; timeoutMs: number; fetch?: FetchLike; baseUrl?: string; sleep?: (ms: number) => Promise<void>; now?: () => number })`
  - `const USER_AGENT = "hiringroom-mcp/0.1.0"`

- [ ] **Step 1: Write the failing tests**

`test/client.test.ts`:
```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/client.test.ts`
Expected: FAIL — cannot resolve `../src/hr/client.js`.

- [ ] **Step 3: Implement `src/hr/client.ts`**

```ts
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
    if (!res.ok) throw new AuthError(`login rechazado por HiringRoom (HTTP ${res.status})`);
    const body = (await res.json()) as { token?: string; expiresIn?: number };
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
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run test/client.test.ts && npx tsc --noEmit`
Expected: 12 tests PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/hr/client.ts test/client.test.ts
git commit -m "feat: add GET-only HiringRoom client with retries and concurrency cap"
```

---

### Task 4: Pagination, catalog cache and stage resolution

**Files:**
- Create: `src/text.ts`, `src/hr/paginate.ts`, `src/hr/catalog.ts`
- Test: `test/paginate.test.ts`, `test/catalog.test.ts`

**Interfaces:**
- Consumes: `HrLike`, `Query` (Task 3); `InputError` (Task 1)
- Produces:
  - `src/text.ts`: `normalize(s: string): string`
  - `src/hr/paginate.ts`: `PAGE_SIZE = 100`; `firstArray(body: unknown): any[]`; `interface PageResult { items: any[]; total: number; completo: boolean; advertencias: string[] }`; `fetchAll(hr: HrLike, path: string, query: Query, maxItems: number, opts?: { deadline?: number; now?: () => number; batch?: number }): Promise<PageResult>`
  - `src/hr/catalog.ts`: `class TtlCache { constructor(ttlMs: number, now?: () => number); get<T>(key: string, load: () => Promise<T>): Promise<T> }`; `interface Stage { id: number; nombre: string }`; `interface Pipeline { id: string; nombre: string; etapas: Stage[] }`; `getPipelines(hr: HrLike, cache: TtlCache): Promise<Pipeline[]>`; `stageName(pipelines: Pipeline[], stageId: number, pipelineId?: string): string | undefined`; `resolveStage(pipelines: Pipeline[], input: string): number`

- [ ] **Step 1: Write the failing tests**

`test/paginate.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { UpstreamError } from "../src/errors.js";
import type { HrLike, Query } from "../src/hr/client.js";
import { fetchAll, firstArray } from "../src/hr/paginate.js";

function pagedHr(total: number, failPages: number[] = []) {
  const calls: Query[] = [];
  const hr: HrLike = {
    async get(_path, query = {}) {
      calls.push(query);
      const page = Number(query.page);
      if (failPages.includes(page)) throw new UpstreamError("boom");
      const size = Number(query.pageSize);
      const start = page * size;
      const n = Math.max(0, Math.min(size, total - start));
      return { total, totalPaginas: Math.ceil(total / size), curriculums: Array.from({ length: n }, (_, i) => ({ id: start + i })) };
    },
    async getBinary() {
      throw new Error("unused");
    },
  };
  return { hr, calls };
}

describe("firstArray", () => {
  it("finds the list in known shapes", () => {
    expect(firstArray([1])).toEqual([1]);
    expect(firstArray({ total: 1, vacantes: [2] })).toEqual([2]);
    expect(firstArray({ x: 1 })).toEqual([]);
    expect(firstArray(null)).toEqual([]);
  });
});

describe("fetchAll", () => {
  it("fetches every page up to maxItems", async () => {
    const { hr, calls } = pagedHr(250);
    const r = await fetchAll(hr, "/postulants/", { vacancyId: "v" }, 1000);
    expect(r.items).toHaveLength(250);
    expect(r).toMatchObject({ total: 250, completo: true, advertencias: [] });
    expect(calls.map((c) => c.page)).toEqual([0, 1, 2]);
    expect(calls[0]).toMatchObject({ vacancyId: "v", pageSize: 100 });
  });

  it("stops at maxItems and flags the partial scan", async () => {
    const { hr, calls } = pagedHr(2500);
    const r = await fetchAll(hr, "/p", {}, 300);
    expect(r.items).toHaveLength(300);
    expect(r.completo).toBe(false);
    expect(r.advertencias[0]).toMatch(/300 de 2500/);
    expect(calls).toHaveLength(3);
  });

  it("tolerates failing pages", async () => {
    const { hr } = pagedHr(250, [1]);
    const r = await fetchAll(hr, "/p", {}, 1000);
    expect(r.items).toHaveLength(150);
    expect(r.completo).toBe(false);
    expect(r.advertencias.join()).toMatch(/página 2/);
  });

  it("stops when the deadline passes", async () => {
    const { hr } = pagedHr(1000);
    let t = 0;
    const r = await fetchAll(hr, "/p", {}, 1000, { deadline: 5, now: () => (t += 10), batch: 2 });
    expect(r.items).toHaveLength(100);
    expect(r.completo).toBe(false);
    expect(r.advertencias.join()).toMatch(/tiempo/);
  });
});
```

`test/catalog.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { InputError } from "../src/errors.js";
import { getPipelines, resolveStage, stageName, TtlCache, type Pipeline } from "../src/hr/catalog.js";
import type { HrLike } from "../src/hr/client.js";
import { normalize } from "../src/text.js";

const PIPES: Pipeline[] = [
  { id: "p1", nombre: "Default", etapas: [{ id: 0, nombre: "NUEVO" }, { id: 2, nombre: "ENTREVISTA" }, { id: 7, nombre: "---" }] },
  { id: "p2", nombre: "Pipeline vigente", etapas: [{ id: 0, nombre: "NUEVO" }, { id: 2, nombre: "ENTREVISTA" }, { id: 7, nombre: "PRESENTADO" }] },
];

describe("normalize", () => {
  it("strips accents, case and extra spaces", () => {
    expect(normalize("  EN REVISIÓN  Ñandú ")).toBe("en revision nandu");
  });
});

describe("TtlCache", () => {
  it("caches until the TTL expires", async () => {
    let t = 0;
    let loads = 0;
    const cache = new TtlCache(1000, () => t);
    const load = async () => ++loads;
    expect(await cache.get("k", load)).toBe(1);
    expect(await cache.get("k", load)).toBe(1);
    t = 1001;
    expect(await cache.get("k", load)).toBe(2);
  });
});

describe("pipelines", () => {
  it("loads and normalizes pipelines once", async () => {
    let calls = 0;
    const hr: HrLike = {
      async get() {
        calls++;
        return [{ id: "p1", nombre: "Default", descripcion: "x", estado: 1, etapas: [{ id: 0, nombre: "NUEVO" }] }];
      },
      async getBinary() {
        throw new Error("unused");
      },
    };
    const cache = new TtlCache(60_000);
    expect(await getPipelines(hr, cache)).toEqual([{ id: "p1", nombre: "Default", etapas: [{ id: 0, nombre: "NUEVO" }] }]);
    await getPipelines(hr, cache);
    expect(calls).toBe(1);
  });

  it("names stages, preferring the vacancy pipeline", () => {
    expect(stageName(PIPES, 7, "p2")).toBe("PRESENTADO");
    expect(stageName(PIPES, 7)).toBe("PRESENTADO");
    expect(stageName(PIPES, 2)).toBe("ENTREVISTA");
    expect(stageName(PIPES, 99)).toBeUndefined();
  });

  it("resolves stage names and ids", () => {
    expect(resolveStage(PIPES, "Entrevista")).toBe(2);
    expect(resolveStage(PIPES, "presentado")).toBe(7);
    expect(resolveStage(PIPES, "7")).toBe(7);
    expect(() => resolveStage(PIPES, "Psicotécnico")).toThrow(InputError);
    expect(() => resolveStage(PIPES, "Psicotécnico")).toThrow(/NUEVO/);
    expect(() => resolveStage(PIPES, "---")).toThrow(InputError);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/paginate.test.ts test/catalog.test.ts`
Expected: FAIL — cannot resolve modules.

- [ ] **Step 3: Implement**

`src/text.ts`:
```ts
/** Lowercase, strip diacritics and collapse whitespace, for accent/case-insensitive matching. */
export function normalize(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
}
```

`src/hr/paginate.ts`:
```ts
import type { HrLike, Query } from "./client.js";

export const PAGE_SIZE = 100;

export interface PageResult {
  items: any[];
  total: number;
  completo: boolean;
  advertencias: string[];
}

/** HiringRoom wraps lists under different keys (vacantes, curriculums, archivos...). */
export function firstArray(body: unknown): any[] {
  if (Array.isArray(body)) return body;
  if (body && typeof body === "object") {
    for (const v of Object.values(body)) if (Array.isArray(v)) return v;
  }
  return [];
}

export async function fetchAll(
  hr: HrLike,
  path: string,
  query: Query,
  maxItems: number,
  opts: { deadline?: number; now?: () => number; batch?: number } = {},
): Promise<PageResult> {
  const now = opts.now ?? Date.now;
  const batch = opts.batch ?? 5;
  const first = await hr.get(path, { ...query, page: 0, pageSize: PAGE_SIZE });
  const items = [...firstArray(first)];
  const total = typeof first?.total === "number" ? first.total : items.length;
  const pages = typeof first?.totalPaginas === "number" ? first.totalPaginas : 1;
  const lastPage = Math.min(pages, Math.ceil(Math.min(total, maxItems) / PAGE_SIZE)) - 1;
  const advertencias: string[] = [];
  let completo = true;

  const remaining = Array.from({ length: Math.max(0, lastPage) }, (_, i) => i + 1);
  for (let i = 0; i < remaining.length; i += batch) {
    if (opts.deadline !== undefined && now() > opts.deadline) {
      completo = false;
      advertencias.push("presupuesto de tiempo agotado: resultados parciales");
      break;
    }
    const chunk = remaining.slice(i, i + batch);
    const results = await Promise.allSettled(chunk.map((page) => hr.get(path, { ...query, page, pageSize: PAGE_SIZE })));
    results.forEach((r, j) => {
      if (r.status === "fulfilled") items.push(...firstArray(r.value));
      else {
        completo = false;
        advertencias.push(`página ${chunk[j] + 1} falló: ${(r.reason as Error).message}`);
      }
    });
  }

  if (total > maxItems) {
    completo = false;
    advertencias.push(`se escanearon ${Math.min(items.length, maxItems)} de ${total}; acotá la búsqueda para cubrir todo`);
  }
  return { items: items.slice(0, maxItems), total, completo, advertencias };
}
```

`src/hr/catalog.ts`:
```ts
import { InputError } from "../errors.js";
import { normalize } from "../text.js";
import type { HrLike } from "./client.js";
import { firstArray } from "./paginate.js";

export class TtlCache {
  private entries = new Map<string, { at: number; value: Promise<unknown> }>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  get<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.entries.get(key);
    if (hit && this.now() - hit.at <= this.ttlMs) return hit.value as Promise<T>;
    const value = load();
    this.entries.set(key, { at: this.now(), value });
    value.catch(() => this.entries.delete(key));
    return value;
  }
}

export interface Stage {
  id: number;
  nombre: string;
}

export interface Pipeline {
  id: string;
  nombre: string;
  etapas: Stage[];
}

const PLACEHOLDER = "---";

export async function getPipelines(hr: HrLike, cache: TtlCache): Promise<Pipeline[]> {
  const raw = await cache.get("pipelines", () => hr.get("/pipeline/"));
  return firstArray(raw).map((p: any) => ({
    id: String(p.id),
    nombre: String(p.nombre ?? ""),
    etapas: (Array.isArray(p.etapas) ? p.etapas : []).map((e: any) => ({ id: Number(e.id), nombre: String(e.nombre ?? "") })),
  }));
}

export function stageName(pipelines: Pipeline[], stageId: number, pipelineId?: string): string | undefined {
  const ordered = [...pipelines].sort((a, b) => Number(b.id === pipelineId) - Number(a.id === pipelineId));
  for (const p of ordered) {
    const s = p.etapas.find((e) => e.id === stageId && e.nombre !== PLACEHOLDER);
    if (s) return s.nombre;
  }
  return undefined;
}

export function resolveStage(pipelines: Pipeline[], input: string): number {
  const trimmed = input.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const wanted = normalize(trimmed);
  const all = pipelines.flatMap((p) => p.etapas).filter((e) => e.nombre !== PLACEHOLDER);
  const ids = [...new Set(all.filter((e) => normalize(e.nombre) === wanted).map((e) => e.id))];
  if (ids.length === 1) return ids[0];
  const valid = [...new Set(all.map((e) => e.nombre))].join(", ");
  if (ids.length === 0) throw new InputError(`etapa desconocida "${input}". Etapas válidas: ${valid}`);
  throw new InputError(`etapa ambigua "${input}" (ids ${ids.join(", ")}); usá el id numérico`);
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/paginate.test.ts test/catalog.test.ts && npx tsc --noEmit`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/text.ts src/hr/paginate.ts src/hr/catalog.ts test/paginate.test.ts test/catalog.test.ts
git commit -m "feat: add pagination, catalog cache and stage resolution"
```

---

### Task 5: Shaping (summaries, sensitive filter, size trim)

**Files:**
- Create: `src/shape/common.ts`, `src/shape/vacancy.ts`, `src/shape/postulant.ts`, `test/fixtures.ts`
- Test: `test/shape.test.ts`

**Interfaces:**
- Consumes: `normalizeHrDate` (Task 2)
- Produces:
  - `src/shape/common.ts`: `compact<T>(v: T): T`; `label(v: unknown): string | undefined`; `personName(v: unknown): string | undefined`; `place(v: unknown): string | undefined`; `siNo(v: unknown): boolean | undefined`; `num(v: unknown): number | undefined`; `arr(v: unknown): any[]`; `jsonBytes(v: unknown): number`; `trimToSize<T extends Record<string, unknown>>(value: T, maxBytes: number): T & { recortado?: true }`
  - `src/shape/vacancy.ts`: `interface VacancySummary { id: string; nombre: string; estado?: string; cliente?: string; area?: string; ubicacion?: string; fecha_creacion?: string; fecha_cierre?: string; posiciones?: number; prioridad?: string; responsables?: string[] }`; `vacancySummary(raw: any): VacancySummary`; `vacancyDetail(raw: any): Record<string, unknown>`
  - `src/shape/postulant.ts`: `interface PostulantSummary { id: string; nombre_completo: string; email?: string; vacante?: { id?: string; nombre?: string }; etapa?: string; rechazado?: boolean; fecha_postulacion?: string; ubicacion?: string; ultimo_puesto?: { puesto?: string; empresa?: string; desde?: string; hasta?: string }; anios_experiencia?: number; nivel_estudio?: string; tags?: string[] }`; `aniosExperiencia(exps: unknown, now: Date): number | undefined`; `postulantSummary(raw: any, now: Date): PostulantSummary`; `postulantProfile(raw: any, now: Date, incluirSensibles: boolean): Record<string, unknown>`
  - `test/fixtures.ts`: `vacancyRaw(o?: Record<string, unknown>)`, `postulantRaw(o?: Record<string, unknown>)`, `pipelinesRaw()`, `NOW: Date`

- [ ] **Step 1: Write fixtures (synthetic, shapes match the 2026-09-23 probe)**

`test/fixtures.ts`:
```ts
// Synthetic data only. Field names/types match the real API (probe 2026-09-23); values are invented.
export const NOW = new Date("2026-09-23T12:00:00-03:00");

export function vacancyRaw(o: Record<string, unknown> = {}) {
  return {
    id: "6a0000000000000000000001",
    nombre: "Soldador calificado - Añelo",
    fechaCreacion: "01-08-2026",
    fechaCierre: null,
    estadoActual: "Activa",
    ubicacion: { pais: "Argentina", provincia: "Neuquén", ciudad: "Añelo" },
    refId: null,
    creadaPor: { id: "u1", nombre: "Ana", apellido: "Paz" },
    salarioOfrecido: "0",
    razonBusqueda: 1,
    requisitos: "Experiencia en soldadura MIG/TIG.",
    areaTrabajo: "Producción",
    subareaTrabajo: "Mantenimiento",
    tipoTrabajo: "Full-time",
    modalidadTrabajo: "Presencial",
    jerarquia: "Junior",
    nivelMinimoEducacion: "Secundario",
    descripcionTrabajo: "Soldadura en planta de tratamiento.",
    posicionesACubrir: 3,
    prioridad: "Media",
    remuneracion: 0,
    currency: "ARS",
    publicada: "Si",
    pipelineId: "p2",
    usuarios: [{ id: "u1", nombre: "Ana", apellido: "Paz" }, { id: "u2", nombre: "Leo", apellido: "Sur" }],
    client: { id: "c1", nombre: "Operadora Sur" },
    micrositios: [],
    ...o,
  };
}

export function postulantRaw(o: Record<string, unknown> = {}) {
  return {
    id: "6b0000000000000000000001",
    nombre: "Juan",
    apellido: "Pérez",
    email: "juan.perez@example.com",
    anonimo: null,
    fechaNacimiento: "01-01-1990",
    telefonoFijo: "+5429900000",
    telefonoCelular: "+5429911111",
    dni: "30000000",
    cuil: null,
    genero: "Masculino",
    fotoPerfil: "https://example.com/foto.jpg",
    presentacionPostulante: "Soldador con experiencia en yacimientos.",
    redesSociales: { linkedin: null, facebook: null, twitter: null, website: null },
    direccion: { pais: "Argentina", provincia: "Neuquén", ciudad: "Añelo", direccion: "Calle Falsa 123", paisId: 1, provinciaId: 2, ciudadId: 3 },
    nacionalidad: "Argentina",
    etapa: "Nuevo",
    experienciasLaborales: [
      { empresa: "Metalúrgica Sur", puesto: "Soldador MIG", mesDesde: 1, añoDesde: 2018, mesHasta: 12, añoHasta: 2021, trabajoActual: false, pais: "Argentina", area: "Producción", subArea: "Soldadura", industria: "Metal", seniority: "Semi-senior", descripcion: "Soldadura de cañerías." },
      { empresa: "Servicios Petroleros", puesto: "Soldador calificado", mesDesde: 6, añoDesde: 2021, mesHasta: null, añoHasta: null, trabajoActual: true, pais: "Argentina", area: "Oil & Gas", subArea: "Mantenimiento", industria: "Petróleo", seniority: "Senior", descripcion: "Mantenimiento de ductos." },
    ],
    estudios: [
      { institucion: "EPET 8", titulo: "Técnico mecánico", mesDesde: 3, añoDesde: 2004, mesHasta: 12, añoHasta: 2009, estudioActual: false, pais: "Argentina", area: "Técnica", nivel: "Secundario", estado: "Graduado", descripcion: null },
    ],
    fechaPostulacion: "20-09-2026",
    fuente: "Web",
    salarioPretendido: null,
    vacanteId: "6a0000000000000000000001",
    vacanteNombre: "Soldador calificado - Añelo",
    rechazado: "No",
    tags: [{ nombre: "Disponible ya", creadoPor: "Ana Paz", fechaCreacion: "21-09-2026" }],
    micrositio: null,
    ...o,
  };
}

export function pipelinesRaw() {
  return [
    { id: "p1", nombre: "Default", descripcion: "x", estado: 1, etapas: [{ id: 0, nombre: "NUEVO" }, { id: 1, nombre: "EN REVISIÓN" }, { id: 2, nombre: "ENTREVISTA" }, { id: 4, nombre: "CONTRATADO" }, { id: 7, nombre: "---" }] },
    { id: "p2", nombre: "Pipeline vigente", descripcion: "y", estado: 1, etapas: [{ id: 0, nombre: "NUEVO" }, { id: 1, nombre: "EN REVISIÓN" }, { id: 2, nombre: "ENTREVISTA" }, { id: 4, nombre: "CONTRATADO" }, { id: 7, nombre: "PRESENTADO" }] },
  ];
}
```

- [ ] **Step 2: Write the failing tests**

`test/shape.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { compact, label, personName, place, siNo, trimToSize, jsonBytes } from "../src/shape/common.js";
import { aniosExperiencia, postulantProfile, postulantSummary } from "../src/shape/postulant.js";
import { vacancyDetail, vacancySummary } from "../src/shape/vacancy.js";
import { NOW, postulantRaw, vacancyRaw } from "./fixtures.js";

describe("common", () => {
  it("compacts nulls, empty strings, arrays and objects recursively", () => {
    expect(compact({ a: null, b: "", c: [], d: {}, e: { f: null, g: 1 }, h: [null, 2], i: 0, j: false })).toEqual({ e: { g: 1 }, h: [2], i: 0, j: false });
  });

  it("extracts labels, names, places and yes/no", () => {
    expect(label({ nombre: "X" })).toBe("X");
    expect(label("  ")).toBeUndefined();
    expect(personName({ nombre: "Ana", apellido: "Paz" })).toBe("Ana Paz");
    expect(place({ ciudad: "Añelo", provincia: "Neuquén", pais: "Argentina" })).toBe("Añelo, Neuquén, Argentina");
    expect(siNo("Sí")).toBe(true);
    expect(siNo("No")).toBe(false);
    expect(siNo(undefined)).toBeUndefined();
  });

  it("trims the longest list until the payload fits", () => {
    const value = { total: 50, items: Array.from({ length: 50 }, (_, i) => ({ i, pad: "x".repeat(100) })) };
    const out = trimToSize(value, 2000);
    expect(jsonBytes(out)).toBeLessThanOrEqual(2000);
    expect(out.recortado).toBe(true);
    expect(out.items.length).toBeLessThan(50);
    expect(value.items).toHaveLength(50); // input untouched
    expect(trimToSize({ a: 1 }, 2000)).toEqual({ a: 1 });
  });
});

describe("vacancy", () => {
  it("summarizes without description or requirements", () => {
    expect(vacancySummary(vacancyRaw())).toEqual({
      id: "6a0000000000000000000001",
      nombre: "Soldador calificado - Añelo",
      estado: "Activa",
      cliente: "Operadora Sur",
      area: "Producción",
      ubicacion: "Añelo, Neuquén, Argentina",
      fecha_creacion: "2026-08-01",
      posiciones: 3,
      prioridad: "Media",
      responsables: ["Ana Paz", "Leo Sur"],
    });
  });

  it("details include description, requirements and pipeline id", () => {
    const d = vacancyDetail(vacancyRaw());
    expect(d).toMatchObject({ descripcion: "Soldadura en planta de tratamiento.", requisitos: "Experiencia en soldadura MIG/TIG.", pipeline_id: "p2", publicada: true });
  });
});

describe("postulant", () => {
  it("computes non-overlapping years of experience", () => {
    const exps = [
      { mesDesde: 1, añoDesde: 2020, mesHasta: 12, añoHasta: 2021, trabajoActual: false },
      { mesDesde: 6, añoDesde: 2021, mesHasta: 6, añoHasta: 2022, trabajoActual: false },
    ];
    expect(aniosExperiencia(exps, NOW)).toBe(2.5);
    expect(aniosExperiencia([], NOW)).toBeUndefined();
  });

  it("summarizes without sensitive fields", () => {
    const s = postulantSummary(postulantRaw(), NOW);
    expect(s).toMatchObject({
      id: "6b0000000000000000000001",
      nombre_completo: "Juan Pérez",
      email: "juan.perez@example.com",
      vacante: { id: "6a0000000000000000000001", nombre: "Soldador calificado - Añelo" },
      etapa: "Nuevo",
      rechazado: false,
      fecha_postulacion: "2026-09-20",
      ubicacion: "Añelo, Neuquén, Argentina",
      ultimo_puesto: { puesto: "Soldador calificado", empresa: "Servicios Petroleros", desde: "2021-06", hasta: "actual" },
      nivel_estudio: "Secundario (Graduado)",
      tags: ["Disponible ya"],
    });
    const text = JSON.stringify(s);
    for (const secret of ["30000000", "01-01-1990", "Masculino", "foto.jpg", "+54299"]) expect(text).not.toContain(secret);
  });

  it("profile hides dni/birth date unless asked; never gender/photo", () => {
    const off = JSON.stringify(postulantProfile(postulantRaw(), NOW, false));
    expect(off).toContain("+5429911111");
    for (const s of ["30000000", "01-01-1990", "Masculino", "foto.jpg"]) expect(off).not.toContain(s);
    const on = JSON.stringify(postulantProfile(postulantRaw(), NOW, true));
    expect(on).toContain("30000000");
    expect(on).toContain("01-01-1990");
    expect(on).not.toContain("Masculino");
    expect(on).not.toContain("foto.jpg");
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/shape.test.ts`
Expected: FAIL — cannot resolve modules.

- [ ] **Step 4: Implement**

`src/shape/common.ts`:
```ts
export function compact<T>(v: T): T {
  if (Array.isArray(v)) {
    return v.map(compact).filter((x) => !isEmpty(x)) as T;
  }
  if (v && typeof v === "object" && !(v instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      const c = compact(x);
      if (!isEmpty(c)) out[k] = c;
    }
    return out as T;
  }
  return v;
}

function isEmpty(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v).length === 0;
  return false;
}

export function label(v: unknown): string | undefined {
  if (typeof v === "string") return v.trim() || undefined;
  if (typeof v === "number") return String(v);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return label(o.nombre ?? o.name ?? o.descripcion ?? o.razonSocial);
  }
  return undefined;
}

export function personName(v: unknown): string | undefined {
  if (typeof v === "string") return v.trim() || undefined;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const full = [label(o.nombre), label(o.apellido)].filter(Boolean).join(" ");
    return full || label(o.email);
  }
  return undefined;
}

export function place(v: unknown): string | undefined {
  if (typeof v === "string") return v.trim() || undefined;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return [label(o.ciudad), label(o.provincia), label(o.pais)].filter(Boolean).join(", ") || undefined;
  }
  return undefined;
}

export function siNo(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  if (typeof v !== "string") return undefined;
  const s = v.trim().toLowerCase();
  if (["si", "sí", "yes", "true", "1"].includes(s)) return true;
  if (["no", "false", "0"].includes(s)) return false;
  return undefined;
}

export function num(v: unknown): number | undefined {
  const n = typeof v === "string" && v.trim() ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

export function arr(v: unknown): any[] {
  return Array.isArray(v) ? v : [];
}

export function jsonBytes(v: unknown): number {
  return Buffer.byteLength(JSON.stringify(v));
}

/** Shortens the longest top-level array until the JSON fits in maxBytes. */
export function trimToSize<T extends Record<string, unknown>>(value: T, maxBytes: number): T & { recortado?: true } {
  if (jsonBytes(value) <= maxBytes) return value;
  const out: Record<string, unknown> = { ...value };
  for (const [k, v] of Object.entries(out)) if (Array.isArray(v)) out[k] = [...v];
  out.recortado = true;
  while (jsonBytes(out) > maxBytes) {
    const lists = Object.values(out).filter((v): v is unknown[] => Array.isArray(v) && v.length > 0);
    if (!lists.length) break;
    const longest = lists.reduce((a, b) => (b.length > a.length ? b : a));
    longest.pop();
  }
  return out as T & { recortado: true };
}
```

`src/shape/vacancy.ts`:
```ts
import { normalizeHrDate } from "../hr/dates.js";
import { arr, compact, label, num, personName, place, siNo } from "./common.js";

export interface VacancySummary {
  id: string;
  nombre: string;
  estado?: string;
  cliente?: string;
  area?: string;
  ubicacion?: string;
  fecha_creacion?: string;
  fecha_cierre?: string;
  posiciones?: number;
  prioridad?: string;
  responsables?: string[];
}

export function vacancySummary(raw: any): VacancySummary {
  return compact({
    id: String(raw.id),
    nombre: label(raw.nombre) ?? "",
    estado: label(raw.estadoActual),
    cliente: label(raw.client),
    area: label(raw.areaTrabajo),
    ubicacion: place(raw.ubicacion),
    fecha_creacion: normalizeHrDate(raw.fechaCreacion),
    fecha_cierre: normalizeHrDate(raw.fechaCierre),
    posiciones: num(raw.posicionesACubrir),
    prioridad: label(raw.prioridad),
    responsables: arr(raw.usuarios).map(personName).filter((x): x is string => !!x),
  });
}

export function vacancyDetail(raw: any): Record<string, unknown> {
  return compact({
    ...vacancySummary(raw),
    subarea: label(raw.subareaTrabajo),
    tipo_trabajo: label(raw.tipoTrabajo),
    modalidad: label(raw.modalidadTrabajo),
    jerarquia: label(raw.jerarquia),
    nivel_minimo_educacion: label(raw.nivelMinimoEducacion),
    remuneracion: num(raw.remuneracion) || undefined,
    moneda: label(raw.currency),
    publicada: siNo(raw.publicada),
    deadline: normalizeHrDate(raw.deadline),
    creada_por: personName(raw.creadaPor),
    pipeline_id: label(raw.pipelineId),
    descripcion: label(raw.descripcionTrabajo),
    requisitos: label(raw.requisitos),
  });
}
```

`src/shape/postulant.ts`:
```ts
import { normalizeHrDate } from "../hr/dates.js";
import { arr, compact, label, num, place, siNo } from "./common.js";

export interface PostulantSummary {
  id: string;
  nombre_completo: string;
  email?: string;
  vacante?: { id?: string; nombre?: string };
  etapa?: string;
  rechazado?: boolean;
  fecha_postulacion?: string;
  ubicacion?: string;
  ultimo_puesto?: { puesto?: string; empresa?: string; desde?: string; hasta?: string };
  anios_experiencia?: number;
  nivel_estudio?: string;
  tags?: string[];
}

const NEVER = ["genero", "fotoPerfil"];
const SENSITIVE = ["dni", "cuil", "fechaNacimiento"];

function monthIndex(year: unknown, month: unknown): number | undefined {
  const y = num(year);
  if (!y) return undefined;
  const m = num(month) ?? 1;
  return y * 12 + (Math.min(Math.max(m, 1), 12) - 1);
}

function interval(e: any, now: Date): [number, number] | undefined {
  const start = monthIndex(e?.añoDesde, e?.mesDesde);
  if (start === undefined) return undefined;
  const end = e?.trabajoActual || e?.estudioActual
    ? now.getFullYear() * 12 + now.getMonth() + 1
    : (monthIndex(e?.añoHasta, e?.mesHasta) ?? start) + 1;
  return end > start ? [start, end] : undefined;
}

export function aniosExperiencia(exps: unknown, now: Date): number | undefined {
  const spans = arr(exps)
    .map((e) => interval(e, now))
    .filter((x): x is [number, number] => !!x)
    .sort((a, b) => a[0] - b[0]);
  if (!spans.length) return undefined;
  let months = 0;
  let [cs, ce] = spans[0];
  for (const [s, e] of spans.slice(1)) {
    if (s <= ce) ce = Math.max(ce, e);
    else {
      months += ce - cs;
      [cs, ce] = [s, e];
    }
  }
  months += ce - cs;
  return Math.round((months / 12) * 10) / 10;
}

function ym(year: unknown, month: unknown): string | undefined {
  const y = num(year);
  if (!y) return undefined;
  const m = num(month);
  return m ? `${y}-${String(m).padStart(2, "0")}` : String(y);
}

function ultimoPuesto(exps: unknown, now: Date) {
  const list = arr(exps);
  if (!list.length) return undefined;
  const endOf = (e: any) => (e?.trabajoActual ? Infinity : (interval(e, now)?.[1] ?? 0));
  const e = list.reduce((a, b) => (endOf(b) > endOf(a) ? b : a));
  return {
    puesto: label(e.puesto),
    empresa: label(e.empresa),
    desde: ym(e.añoDesde, e.mesDesde),
    hasta: e.trabajoActual ? "actual" : ym(e.añoHasta, e.mesHasta),
  };
}

function nivelEstudio(estudios: unknown): string | undefined {
  const list = arr(estudios);
  if (!list.length) return undefined;
  const endOf = (e: any) => (e?.estudioActual ? Infinity : (num(e?.añoHasta) ?? 0));
  const e = list.reduce((a, b) => (endOf(b) > endOf(a) ? b : a));
  const nivel = label(e.nivel);
  const estado = label(e.estado);
  return nivel && estado ? `${nivel} (${estado})` : nivel;
}

function fullName(raw: any): string {
  return [label(raw.nombre), label(raw.apellido)].filter(Boolean).join(" ");
}

export function postulantSummary(raw: any, now: Date): PostulantSummary {
  return compact({
    id: String(raw.id),
    nombre_completo: fullName(raw),
    email: label(raw.email),
    vacante: { id: label(raw.vacanteId), nombre: label(raw.vacanteNombre) },
    etapa: label(raw.etapa),
    rechazado: siNo(raw.rechazado),
    fecha_postulacion: normalizeHrDate(raw.fechaPostulacion),
    ubicacion: place(raw.direccion),
    ultimo_puesto: ultimoPuesto(raw.experienciasLaborales, now),
    anios_experiencia: aniosExperiencia(raw.experienciasLaborales, now),
    nivel_estudio: nivelEstudio(raw.estudios),
    tags: arr(raw.tags).map(label).filter((x): x is string => !!x),
  });
}

export function postulantProfile(raw: any, now: Date, incluirSensibles: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw };
  for (const k of NEVER) delete out[k];
  if (!incluirSensibles) for (const k of SENSITIVE) delete out[k];
  return compact({
    nombre_completo: fullName(raw),
    anios_experiencia: aniosExperiencia(raw.experienciasLaborales, now),
    ...out,
  });
}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run test/shape.test.ts && npx tsc --noEmit`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/shape test/fixtures.ts test/shape.test.ts
git commit -m "feat: add payload shaping with sensitive-field filter and size trim"
```

---

### Task 6: Cross-search scoring

**Files:**
- Create: `src/search/perfil.ts`
- Test: `test/perfil.test.ts`

**Interfaces:**
- Consumes: `normalize` (Task 4); `label`, `place`, `arr` (Task 5); `normalizeHrDate` (Task 2)
- Produces: `WEIGHTS`; `type Campo = keyof typeof WEIGHTS`; `interface Match { palabra: string; campo: Campo }`; `interface Scored { score: number; coincidencias: Match[] }`; `scoreCandidate(raw: any, palabras: string[], excluir?: string[], cvText?: string): Scored | null`; `interface Ranked extends Scored { raw: any; vacantes: { id?: string; nombre?: string }[] }`; `rank(raws: any[], palabras: string[], excluir?: string[], cvById?: Map<string, string>): Ranked[]`

- [ ] **Step 1: Write the failing tests**

`test/perfil.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { rank, scoreCandidate } from "../src/search/perfil.js";
import { postulantRaw } from "./fixtures.js";

describe("scoreCandidate", () => {
  it("matches accent/case-insensitive prefixes and weights by field", () => {
    const s = scoreCandidate(postulantRaw(), ["SOLDAD", "neuquen"]);
    expect(s).toEqual({
      score: 3 + 1,
      coincidencias: [
        { palabra: "SOLDAD", campo: "puesto" },
        { palabra: "neuquen", campo: "ubicacion" },
      ],
    });
  });

  it("matches phrases as consecutive tokens", () => {
    expect(scoreCandidate(postulantRaw(), ["soldador calificado"])?.score).toBe(3);
    expect(scoreCandidate(postulantRaw(), ["calificado soldador"])).toBeNull();
  });

  it("returns null when nothing matches or an exclusion matches", () => {
    expect(scoreCandidate(postulantRaw(), ["electricista"])).toBeNull();
    expect(scoreCandidate(postulantRaw(), ["soldador"], ["ductos"])).toBeNull(); // matches an experience description
  });

  it("uses CV text with weight 1", () => {
    expect(scoreCandidate(postulantRaw(), ["api 1104"])).toBeNull();
    expect(scoreCandidate(postulantRaw(), ["api 1104"], [], "Certificación API 1104 vigente")).toEqual({
      score: 1,
      coincidencias: [{ palabra: "api 1104", campo: "cv" }],
    });
  });

  it("scores education titles, areas and tags", () => {
    expect(scoreCandidate(postulantRaw(), ["tecnico mecanico"])?.coincidencias[0].campo).toBe("titulo_estudio");
    expect(scoreCandidate(postulantRaw(), ["oil"])?.coincidencias[0].campo).toBe("area");
    expect(scoreCandidate(postulantRaw(), ["disponible"])?.coincidencias[0].campo).toBe("tag");
  });
});

describe("rank", () => {
  it("dedups by postulant id, keeps best score, lists vacancies, sorts by score then recency", () => {
    const a1 = postulantRaw({ id: "A", vacanteId: "v1", vacanteNombre: "V1", fechaPostulacion: "01-09-2026" });
    const a2 = postulantRaw({ id: "A", vacanteId: "v2", vacanteNombre: "V2", presentacionPostulante: "neuquen" });
    const b = postulantRaw({ id: "B", experienciasLaborales: [], estudios: [], tags: [], direccion: {}, presentacionPostulante: "soldador", fechaPostulacion: "22-09-2026" });
    const c = postulantRaw({ id: "C", experienciasLaborales: [], estudios: [], tags: [], direccion: {}, presentacionPostulante: "soldador", fechaPostulacion: "10-09-2026" });
    const d = postulantRaw({ id: "D", experienciasLaborales: [], estudios: [], tags: [], direccion: {}, presentacionPostulante: "cocinero" });
    const r = rank([a1, a2, b, c, d], ["soldador"]);
    expect(r.map((x) => x.raw.id)).toEqual(["A", "B", "C"]);
    expect(r[0].vacantes).toEqual([{ id: "v1", nombre: "V1" }, { id: "v2", nombre: "V2" }]);
  });

  it("applies CV text per postulant", () => {
    const x = postulantRaw({ id: "X", experienciasLaborales: [], estudios: [], tags: [], direccion: {}, presentacionPostulante: "" });
    expect(rank([x], ["tig"])).toEqual([]);
    expect(rank([x], ["tig"], [], new Map([["X", "Soldadura TIG"]]))[0].score).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/perfil.test.ts`
Expected: FAIL — cannot resolve `../src/search/perfil.js`.

- [ ] **Step 3: Implement `src/search/perfil.ts`**

```ts
import { normalizeHrDate } from "../hr/dates.js";
import { arr, label, place } from "../shape/common.js";
import { normalize } from "../text.js";

export const WEIGHTS = {
  puesto: 3,
  titulo_estudio: 2,
  area: 2,
  tag: 2,
  descripcion: 1,
  presentacion: 1,
  ubicacion: 1,
  cv: 1,
} as const;

export type Campo = keyof typeof WEIGHTS;

export interface Match {
  palabra: string;
  campo: Campo;
}

export interface Scored {
  score: number;
  coincidencias: Match[];
}

export interface Ranked extends Scored {
  raw: any;
  vacantes: { id?: string; nombre?: string }[];
}

function tokens(s: string): string[] {
  return normalize(s).split(/[^a-z0-9]+/).filter(Boolean);
}

function fieldsOf(raw: any, cvText?: string): Array<[Campo, string[]]> {
  const f: Array<[Campo, string | undefined]> = [];
  for (const e of arr(raw.experienciasLaborales)) {
    f.push(["puesto", label(e?.puesto)], ["area", label(e?.area)], ["area", label(e?.subArea)], ["descripcion", label(e?.descripcion)]);
  }
  for (const e of arr(raw.estudios)) f.push(["titulo_estudio", label(e?.titulo)]);
  for (const t of arr(raw.tags)) f.push(["tag", label(t)]);
  f.push(["presentacion", label(raw.presentacionPostulante)], ["ubicacion", place(raw.direccion)], ["cv", cvText]);
  return f.filter((x): x is [Campo, string] => !!x[1]).map(([c, t]) => [c, tokens(t)]);
}

/** Every query token must prefix-match consecutive field tokens. */
function contains(field: string[], query: string[]): boolean {
  if (!query.length) return false;
  for (let i = 0; i + query.length <= field.length; i++) {
    if (query.every((q, j) => field[i + j].startsWith(q))) return true;
  }
  return false;
}

export function scoreCandidate(raw: any, palabras: string[], excluir: string[] = [], cvText?: string): Scored | null {
  const fields = fieldsOf(raw, cvText);
  if (excluir.some((ex) => fields.some(([, toks]) => contains(toks, tokens(ex))))) return null;
  let score = 0;
  const coincidencias: Match[] = [];
  for (const palabra of palabras) {
    const q = tokens(palabra);
    let best: Campo | undefined;
    for (const [campo, toks] of fields) {
      if ((!best || WEIGHTS[campo] > WEIGHTS[best]) && contains(toks, q)) best = campo;
    }
    if (best) {
      score += WEIGHTS[best];
      coincidencias.push({ palabra, campo: best });
    }
  }
  return score > 0 ? { score, coincidencias } : null;
}

export function rank(raws: any[], palabras: string[], excluir: string[] = [], cvById?: Map<string, string>): Ranked[] {
  const byId = new Map<string, Ranked>();
  for (const raw of raws) {
    const id = String(raw.id);
    const s = scoreCandidate(raw, palabras, excluir, cvById?.get(id));
    if (!s) continue;
    const vacante = { id: label(raw.vacanteId), nombre: label(raw.vacanteNombre) };
    const prev = byId.get(id);
    if (!prev) {
      byId.set(id, { raw, ...s, vacantes: [vacante] });
      continue;
    }
    if (!prev.vacantes.some((v) => v.id === vacante.id)) prev.vacantes.push(vacante);
    if (s.score > prev.score) Object.assign(prev, { raw, score: s.score, coincidencias: s.coincidencias });
  }
  const date = (r: Ranked) => normalizeHrDate(r.raw.fechaPostulacion) ?? "";
  return [...byId.values()].sort((a, b) => b.score - a.score || date(b).localeCompare(date(a)));
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/perfil.test.ts && npx tsc --noEmit`
Expected: all PASS.

Note on the "dedups" test: `a2` scores 3 (puesto) + nothing for "soldador" beyond that, same as `a1`; the test asserts A ranks first because A's score (3, puesto) beats B and C (1, presentacion). B ranks before C by recency.

- [ ] **Step 5: Commit**

```bash
git add src/search/perfil.ts test/perfil.test.ts
git commit -m "feat: add cross-search scoring and ranking"
```

---

### Task 7: CV text extraction

**Files:**
- Create: `src/cv/extract.ts`, `test/helpers/pdf.ts`
- Test: `test/extract.test.ts`

**Interfaces:**
- Consumes: `InputError` (Task 1), `ConfigError` (Task 1)
- Produces: `assertPdftotext(): Promise<void>`; `type CvKind = "pdf" | "docx" | "otro"`; `detectKind(bytes: Buffer): CvKind`; `extractText(bytes: Buffer): Promise<string>`; `cleanText(s: string): string`; `truncate(s: string, max: number): { texto: string; truncado: boolean }`; test helper `minimalPdf(text: string): Buffer`

- [ ] **Step 1: Write the PDF helper and failing tests**

`test/helpers/pdf.ts`:
```ts
/** Builds a valid one-page PDF with ASCII `text` (enough for pdftotext). */
export function minimalPdf(text: string): Buffer {
  const content = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
```

`test/extract.test.ts`:
```ts
import { describe, expect, it, vi } from "vitest";
import { InputError } from "../src/errors.js";
import { minimalPdf } from "./helpers/pdf.js";

vi.mock("mammoth", () => ({ default: { extractRawText: vi.fn(async () => ({ value: "Soldador   TIG\n\n\n\nNeuquén" })) } }));

const { assertPdftotext, cleanText, detectKind, extractText, truncate } = await import("../src/cv/extract.js");

describe("cv extract", () => {
  it("finds pdftotext", async () => {
    await expect(assertPdftotext()).resolves.toBeUndefined();
  });

  it("detects kinds by magic bytes", () => {
    expect(detectKind(Buffer.from("%PDF-1.7"))).toBe("pdf");
    expect(detectKind(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0]))).toBe("docx");
    expect(detectKind(Buffer.from("GIF89a"))).toBe("otro");
  });

  it("extracts PDF text", async () => {
    expect(await extractText(minimalPdf("Soldador calificado Neuquen"))).toContain("Soldador calificado Neuquen");
  });

  it("extracts DOCX text via mammoth and cleans whitespace", async () => {
    expect(await extractText(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0]))).toBe("Soldador TIG\n\nNeuquén");
  });

  it("rejects unsupported formats", async () => {
    await expect(extractText(Buffer.from("GIF89a"))).rejects.toBeInstanceOf(InputError);
  });

  it("cleans and truncates", () => {
    expect(cleanText(" a \t b \r\n\n\n\n c ")).toBe("a b\n\nc");
    expect(truncate("abcdef", 4)).toEqual({ texto: "abcd", truncado: true });
    expect(truncate("abc", 4)).toEqual({ texto: "abc", truncado: false });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/extract.test.ts`
Expected: FAIL — cannot resolve `../src/cv/extract.js`.

- [ ] **Step 3: Implement `src/cv/extract.ts`**

```ts
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import mammoth from "mammoth";
import { ConfigError } from "../config.js";
import { InputError } from "../errors.js";

const run = promisify(execFile);

export type CvKind = "pdf" | "docx" | "otro";

export async function assertPdftotext(): Promise<void> {
  try {
    await run("pdftotext", ["-v"]);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ConfigError("falta pdftotext en el PATH (macOS: brew install poppler)");
    }
    // pdftotext -v exits non-zero on some builds; being found is enough.
  }
}

export function detectKind(bytes: Buffer): CvKind {
  if (bytes.subarray(0, 5).toString("latin1") === "%PDF-") return "pdf";
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) return "docx";
  return "otro";
}

export function cleanText(s: string): string {
  return s
    .replace(/\r/g, "")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function truncate(s: string, max: number): { texto: string; truncado: boolean } {
  return s.length > max ? { texto: s.slice(0, max), truncado: true } : { texto: s, truncado: false };
}

async function pdfText(bytes: Buffer): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "hrmcp-"));
  try {
    const file = join(dir, "cv.pdf");
    await writeFile(file, bytes, { mode: 0o600 });
    const { stdout } = await run("pdftotext", ["-enc", "UTF-8", file, "-"], { maxBuffer: 32 * 1024 * 1024 });
    return stdout;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function extractText(bytes: Buffer): Promise<string> {
  const kind = detectKind(bytes);
  if (kind === "pdf") return cleanText(await pdfText(bytes));
  if (kind === "docx") return cleanText((await mammoth.extractRawText({ buffer: bytes })).value);
  throw new InputError("formato de archivo no soportado (solo PDF o DOCX)");
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/extract.test.ts && npx tsc --noEmit`
Expected: all PASS. If `pdftotext` is missing locally, install poppler (`brew install poppler`) — do not skip the test.

- [ ] **Step 5: Commit**

```bash
git add src/cv/extract.ts test/helpers/pdf.ts test/extract.test.ts
git commit -m "feat: add PDF/DOCX CV text extraction"
```

---

### Task 8: Logging and audit

**Files:**
- Create: `src/log.ts`, `src/audit.ts`
- Test: `test/audit.test.ts`

**Interfaces:**
- Produces:
  - `src/log.ts`: `redact(v: unknown): unknown`; `logError(msg: string, extra?: unknown): void`
  - `src/audit.ts`: `interface AuditEntry { tool: string; params: Record<string, unknown>; ms: number; resultado: "ok" | "error"; n_items?: number; completo?: boolean }`; `interface Audit { log(e: AuditEntry): void }`; `hashValue(v: string): string`; `sanitizeParams(p: Record<string, unknown>): Record<string, unknown>`; `createFileAudit(dir: string, opts?: { maxBytes?: number; keep?: number; now?: () => Date }): Audit`; `memoryAudit(): Audit & { entries: Record<string, unknown>[] }`

- [ ] **Step 1: Write the failing tests**

`test/audit.test.ts`:
```ts
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFileAudit, hashValue, memoryAudit, sanitizeParams } from "../src/audit.js";
import { redact } from "../src/log.js";

describe("redact", () => {
  it("replaces secret keys deeply", () => {
    expect(redact({ token: "t", a: { password: "p", client_secret: "s", ok: 1 }, list: [{ refreshToken: "r" }] })).toEqual({
      token: "[redacted]",
      a: { password: "[redacted]", client_secret: "[redacted]", ok: 1 },
      list: [{ refreshToken: "[redacted]" }],
    });
  });
});

describe("audit", () => {
  it("hashes personal params", () => {
    const p = sanitizeParams({ email: "a@b.com", nombre: "Juan", apellido: "Pérez", vacante_id: "v1" });
    expect(p).toEqual({ email: `sha256:${hashValue("a@b.com")}`, nombre: `sha256:${hashValue("Juan")}`, apellido: `sha256:${hashValue("Pérez")}`, vacante_id: "v1" });
    expect(hashValue("x")).toMatch(/^[0-9a-f]{12}$/);
  });

  it("writes one JSON line per call without plain PII", () => {
    const dir = mkdtempSync(join(tmpdir(), "hraudit-"));
    const audit = createFileAudit(dir, { now: () => new Date("2026-09-23T12:00:00Z") });
    audit.log({ tool: "buscar_postulantes", params: { email: "juan@x.com" }, ms: 12, resultado: "ok", n_items: 3 });
    const lines = readFileSync(join(dir, "audit.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]);
    expect(entry).toMatchObject({ ts: "2026-09-23T12:00:00.000Z", tool: "buscar_postulantes", ms: 12, resultado: "ok", n_items: 3 });
    expect(lines[0]).not.toContain("juan@x.com");
  });

  it("rotates at maxBytes and keeps `keep` old files", () => {
    const dir = mkdtempSync(join(tmpdir(), "hraudit-"));
    const audit = createFileAudit(dir, { maxBytes: 200, keep: 2 });
    for (let i = 0; i < 20; i++) audit.log({ tool: "t", params: { i }, ms: 1, resultado: "ok" });
    expect(existsSync(join(dir, "audit.jsonl"))).toBe(true);
    expect(existsSync(join(dir, "audit.jsonl.1"))).toBe(true);
    expect(existsSync(join(dir, "audit.jsonl.2"))).toBe(true);
    expect(existsSync(join(dir, "audit.jsonl.3"))).toBe(false);
  });

  it("memoryAudit collects sanitized entries", () => {
    const a = memoryAudit();
    a.log({ tool: "t", params: { nombre: "Ana" }, ms: 1, resultado: "error" });
    expect(a.entries[0]).toMatchObject({ tool: "t", resultado: "error" });
    expect(JSON.stringify(a.entries)).not.toContain("Ana");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/audit.test.ts`
Expected: FAIL — cannot resolve modules.

- [ ] **Step 3: Implement**

`src/log.ts`:
```ts
const SECRET_KEY = /^(token|password|client_secret|clientsecret|refreshtoken|hr_password|hr_client_secret)$/i;

export function redact(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = SECRET_KEY.test(k) ? "[redacted]" : redact(x);
    return out;
  }
  return v;
}

/** Operational log. Never stdout: stdout carries the MCP protocol. */
export function logError(msg: string, extra?: unknown): void {
  const suffix = extra === undefined ? "" : ` ${JSON.stringify(redact(extra))}`;
  process.stderr.write(`[hiringroom-mcp] ${msg}${suffix}\n`);
}
```

`src/audit.ts`:
```ts
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { logError, redact } from "./log.js";

export interface AuditEntry {
  tool: string;
  params: Record<string, unknown>;
  ms: number;
  resultado: "ok" | "error";
  n_items?: number;
  completo?: boolean;
}

export interface Audit {
  log(e: AuditEntry): void;
}

const PII_PARAMS = ["email", "nombre", "apellido"];

export function hashValue(v: string): string {
  return createHash("sha256").update(v).digest("hex").slice(0, 12);
}

export function sanitizeParams(p: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...p };
  for (const k of PII_PARAMS) if (typeof out[k] === "string") out[k] = `sha256:${hashValue(out[k] as string)}`;
  return redact(out) as Record<string, unknown>;
}

function line(e: AuditEntry, now: Date): Record<string, unknown> {
  return { ts: now.toISOString(), ...e, params: sanitizeParams(e.params) };
}

export function createFileAudit(
  dir: string,
  opts: { maxBytes?: number; keep?: number; now?: () => Date } = {},
): Audit {
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
  const keep = opts.keep ?? 5;
  const now = opts.now ?? (() => new Date());
  const file = join(dir, "audit.jsonl");

  function rotate(): void {
    if (!existsSync(file) || statSync(file).size < maxBytes) return;
    rmSync(`${file}.${keep}`, { force: true });
    for (let i = keep - 1; i >= 1; i--) if (existsSync(`${file}.${i}`)) renameSync(`${file}.${i}`, `${file}.${i + 1}`);
    renameSync(file, `${file}.1`);
  }

  return {
    log(e) {
      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        rotate();
        appendFileSync(file, `${JSON.stringify(line(e, now()))}\n`, { mode: 0o600 });
      } catch (err) {
        logError("no se pudo escribir el audit log", { error: String(err) });
      }
    },
  };
}

export function memoryAudit(): Audit & { entries: Record<string, unknown>[] } {
  const entries: Record<string, unknown>[] = [];
  return { entries, log: (e) => entries.push(line(e, new Date())) };
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/audit.test.ts && npx tsc --noEmit`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/log.ts src/audit.ts test/audit.test.ts
git commit -m "feat: add redacting logger and PII-free audit log with rotation"
```

---

### Task 9: Tool wrapper, server, test harness, `catalogos`, stdio entry

**Files:**
- Create: `src/tools/context.ts`, `src/tools/define.ts`, `src/tools/catalogos.ts`, `src/tools/index.ts`, `src/server.ts`, `src/index.ts`, `test/helpers/harness.ts`
- Test: `test/catalogos.test.ts`, `test/define.test.ts`

**Interfaces:**
- Consumes: `HrLike` (Task 3); `TtlCache`, `getPipelines` (Task 4); `firstArray` (Task 4); `compact`, `trimToSize` (Task 5); `Audit`, `memoryAudit`, `createFileAudit` (Task 8); `logError` (Task 8); `Limits`, `DEFAULT_LIMITS`, `loadConfig`, `ConfigError` (Task 1); errors (Task 1); `assertPdftotext` (Task 7)
- Produces:
  - `src/tools/context.ts`: `interface ToolContext { hr: HrLike; cache: TtlCache; limits: Limits; now: () => Date }`; `type ToolResult = Record<string, unknown>`
  - `src/tools/define.ts`: `interface ToolDef<S extends ZodRawShape = ZodRawShape> { name: string; description: string; input: S; maxBytes?: (limits: Limits) => number; run(args: z.objectOutputType<S, ZodTypeAny>, ctx: ToolContext): Promise<ToolResult> }`; `defineTool<S>(def: ToolDef<S>): ToolDef<S>`; `registerTool(server: McpServer, ctx: ToolContext, audit: Audit, def: ToolDef<any>): void`; `errorMessage(err: unknown): string`; `orNotFound<T>(p: Promise<T>, recurso: string, id: string): Promise<T>`; `settle<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }>`; `unwrap(body: any, ...keys: string[]): any`; `enc(s: string): string`; shared Zod pieces `isoDate`, `limite`, `pagina`
  - `src/tools/index.ts`: `ALL_TOOLS: ToolDef<any>[]`
  - `src/server.ts`: `createServer(ctx: ToolContext, audit: Audit): McpServer`
  - `test/helpers/harness.ts`: `type Route = unknown | ((query: Record<string, unknown>) => unknown)`; `class FakeHr implements HrLike { calls: { path: string; query: Record<string, unknown> }[]; constructor(routes: Record<string, Route>, binaries?: Record<string, HrBinary>) }`; `connect(hr: HrLike, opts?: { limits?: Partial<Limits> }): Promise<{ call(name: string, args?: Record<string, unknown>): Promise<{ isError: boolean; text: string; json: any }>; audit: ReturnType<typeof memoryAudit>; listTools(): Promise<string[]> }>`

- [ ] **Step 1: Write the harness**

`test/helpers/harness.ts`:
```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { memoryAudit } from "../../src/audit.js";
import { DEFAULT_LIMITS, type Limits } from "../../src/config.js";
import { NotFoundError } from "../../src/errors.js";
import { TtlCache } from "../../src/hr/catalog.js";
import type { HrBinary, HrLike, Query } from "../../src/hr/client.js";
import { createServer } from "../../src/server.js";
import { NOW } from "../fixtures.js";

export type Route = unknown | ((query: Record<string, unknown>) => unknown);

export class FakeHr implements HrLike {
  calls: { path: string; query: Record<string, unknown> }[] = [];

  constructor(
    private routes: Record<string, Route>,
    private binaries: Record<string, HrBinary> = {},
  ) {}

  async get<T>(path: string, query: Query = {}): Promise<T> {
    this.calls.push({ path, query });
    if (!(path in this.routes)) throw new NotFoundError(path);
    const route = this.routes[path];
    const value = typeof route === "function" ? await (route as (q: Record<string, unknown>) => unknown)(query) : route;
    if (value instanceof Error) throw value;
    return structuredClone(value) as T;
  }

  async getBinary(path: string): Promise<HrBinary> {
    this.calls.push({ path, query: {} });
    const b = this.binaries[path];
    if (!b) throw new NotFoundError(path);
    return b;
  }
}

export async function connect(hr: HrLike, opts: { limits?: Partial<Limits> } = {}) {
  const audit = memoryAudit();
  const ctx = { hr, cache: new TtlCache(3_600_000), limits: { ...DEFAULT_LIMITS, ...opts.limits }, now: () => NOW };
  const server = createServer(ctx, audit);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return {
    audit,
    async listTools(): Promise<string[]> {
      return (await client.listTools()).tools.map((t) => t.name).sort();
    },
    async call(name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; text: string; json: any }> {
      try {
        const r = await client.callTool({ name, arguments: args });
        const text = (r.content as { type: string; text: string }[])[0]?.text ?? "";
        return { isError: !!r.isError, text, json: r.isError ? undefined : JSON.parse(text) };
      } catch (err) {
        // Depending on the SDK version, schema validation errors are thrown instead of returned as isError.
        return { isError: true, text: err instanceof Error ? err.message : String(err), json: undefined };
      }
    },
  };
}
```

- [ ] **Step 2: Write the failing tests**

`test/catalogos.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { pipelinesRaw } from "./fixtures.js";
import { connect, FakeHr } from "./helpers/harness.js";

describe("catalogos", () => {
  it("lists pipelines with stages", async () => {
    const t = await connect(new FakeHr({ "/pipeline/": pipelinesRaw() }));
    const r = await t.call("catalogos", { tipo: "pipelines" });
    expect(r.isError).toBe(false);
    expect(r.json.items[1]).toMatchObject({ id: "p2", nombre: "Pipeline vigente" });
    expect(r.json.items[1].etapas).toContainEqual({ id: 7, nombre: "PRESENTADO" });
  });

  it("lists clients from the list key and caches them", async () => {
    const hr = new FakeHr({ "/account/customers": { clientes: [{ id: "c1", nombre: "Operadora Sur" }] } });
    const t = await connect(hr);
    const r = await t.call("catalogos", { tipo: "clientes" });
    expect(r.json).toEqual({ tipo: "clientes", total: 1, items: [{ id: "c1", nombre: "Operadora Sur" }] });
    await t.call("catalogos", { tipo: "clientes" });
    expect(hr.calls).toHaveLength(1);
  });

  it("rejects unknown types via schema", async () => {
    const t = await connect(new FakeHr({}));
    const r = await t.call("catalogos", { tipo: "otra" });
    expect(r.isError).toBe(true);
  });
});
```

`test/define.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { AuthError, HrValidationError, InputError, NotFoundError, UpstreamError } from "../src/errors.js";
import { errorMessage, orNotFound, unwrap } from "../src/tools/define.js";
import { connect, FakeHr } from "./helpers/harness.js";

describe("errorMessage", () => {
  it("maps typed errors to Spanish messages", () => {
    expect(errorMessage(new InputError("x mal"))).toBe("x mal");
    expect(errorMessage(new AuthError("t"))).toBe("credenciales de HiringRoom inválidas, revisar .env");
    expect(errorMessage(new NotFoundError("/v/1", "no existe vacante `1`"))).toBe("no existe vacante `1`");
    expect(errorMessage(new HrValidationError(["a", "b"]))).toBe("HiringRoom rechazó el pedido: a; b");
    expect(errorMessage(new UpstreamError("t"))).toBe("HiringRoom no responde, reintentar más tarde");
    expect(errorMessage(new Error("secret stack"))).toBe("error interno del MCP (ver logs)");
  });

  it("orNotFound rewrites the message; unwrap finds the payload", async () => {
    await expect(orNotFound(Promise.reject(new NotFoundError("/x")), "vacante", "9")).rejects.toThrow("no existe vacante `9`");
    expect(unwrap({ postulant: { id: 1 } }, "postulant")).toEqual({ id: 1 });
    expect(unwrap({ id: 2 }, "postulant")).toEqual({ id: 2 });
  });
});

describe("registerTool", () => {
  it("audits ok and error calls; auth failure does not crash the server", async () => {
    const t = await connect(new FakeHr({ "/pipeline/": () => new AuthError("bad"), "/account/areas": [{ id: 1 }] }));
    const bad = await t.call("catalogos", { tipo: "pipelines" });
    expect(bad).toMatchObject({ isError: true, text: "credenciales de HiringRoom inválidas, revisar .env" });
    const ok = await t.call("catalogos", { tipo: "areas" });
    expect(ok.isError).toBe(false);
    expect(t.audit.entries.map((e) => e.resultado)).toEqual(["error", "ok"]);
    expect(t.audit.entries[1]).toMatchObject({ tool: "catalogos", n_items: 1 });
  });

  it("trims oversized responses", async () => {
    const big = Array.from({ length: 500 }, (_, i) => ({ id: i, nombre: "x".repeat(100) }));
    const t = await connect(new FakeHr({ "/account/areas": big }), { limits: { responseMaxBytes: 5000 } });
    const r = await t.call("catalogos", { tipo: "areas" });
    expect(r.json.recortado).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(5000);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/catalogos.test.ts test/define.test.ts`
Expected: FAIL — cannot resolve `../../src/server.js` / `../src/tools/define.js`.

- [ ] **Step 4: Implement**

`src/tools/context.ts`:
```ts
import type { Limits } from "../config.js";
import type { TtlCache } from "../hr/catalog.js";
import type { HrLike } from "../hr/client.js";

export interface ToolContext {
  hr: HrLike;
  cache: TtlCache;
  limits: Limits;
  now: () => Date;
}

export type ToolResult = Record<string, unknown>;
```

`src/tools/define.ts`:
```ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z, type ZodRawShape, type ZodTypeAny } from "zod";
import type { Audit } from "../audit.js";
import type { Limits } from "../config.js";
import { AuthError, HrValidationError, InputError, NotFoundError, UpstreamError } from "../errors.js";
import { logError } from "../log.js";
import { compact, trimToSize } from "../shape/common.js";
import type { ToolContext, ToolResult } from "./context.js";

export interface ToolDef<S extends ZodRawShape = ZodRawShape> {
  name: string;
  description: string;
  input: S;
  maxBytes?: (limits: Limits) => number;
  run(args: z.objectOutputType<S, ZodTypeAny>, ctx: ToolContext): Promise<ToolResult>;
}

export function defineTool<S extends ZodRawShape>(def: ToolDef<S>): ToolDef<S> {
  return def;
}

export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "usar YYYY-MM-DD");
export const limite = z.number().int().min(10).max(100).default(20).describe("resultados por página (10-100)");
export const pagina = z.number().int().min(1).default(1).describe("página, empieza en 1");

export function enc(s: string): string {
  return encodeURIComponent(s);
}

export function errorMessage(err: unknown): string {
  if (err instanceof InputError) return err.message;
  if (err instanceof AuthError) return "credenciales de HiringRoom inválidas, revisar .env";
  if (err instanceof NotFoundError) return err.message;
  if (err instanceof HrValidationError) return `HiringRoom rechazó el pedido: ${err.messages.join("; ")}`;
  if (err instanceof UpstreamError) return "HiringRoom no responde, reintentar más tarde";
  logError("error inesperado en una tool", { error: err instanceof Error ? err.stack : String(err) });
  return "error interno del MCP (ver logs)";
}

export async function orNotFound<T>(p: Promise<T>, recurso: string, id: string): Promise<T> {
  try {
    return await p;
  } catch (err) {
    if (err instanceof NotFoundError) throw new NotFoundError(err.path, `no existe ${recurso} \`${id}\``);
    throw err;
  }
}

export async function settle<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await p };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

/** HiringRoom sometimes wraps a single object ({ postulant: {...} }). */
export function unwrap(body: any, ...keys: string[]): any {
  for (const k of keys) if (body && typeof body === "object" && body[k] && typeof body[k] === "object") return body[k];
  return body;
}

export function registerTool(server: McpServer, ctx: ToolContext, audit: Audit, def: ToolDef<any>): void {
  server.registerTool(def.name, { description: def.description, inputSchema: def.input }, async (args: any) => {
    const started = Date.now();
    try {
      const maxBytes = def.maxBytes ? def.maxBytes(ctx.limits) : ctx.limits.responseMaxBytes;
      const result = trimToSize(compact(await def.run(args, ctx)), maxBytes);
      audit.log({
        tool: def.name,
        params: args,
        ms: Date.now() - started,
        resultado: "ok",
        n_items: Array.isArray(result.items) ? result.items.length : undefined,
        completo: typeof result.completo === "boolean" ? result.completo : undefined,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    } catch (err) {
      audit.log({ tool: def.name, params: args, ms: Date.now() - started, resultado: "error" });
      return { isError: true, content: [{ type: "text" as const, text: errorMessage(err) }] };
    }
  });
}
```

`src/tools/catalogos.ts`:
```ts
import { z } from "zod";
import { getPipelines } from "../hr/catalog.js";
import { firstArray } from "../hr/paginate.js";
import { defineTool } from "./define.js";

const SOURCES = {
  clientes: "/account/customers",
  areas: "/account/areas",
  motivos_rechazo: "/common/rejectReasons",
  fuentes: "/common/sources",
} as const;

export const catalogos = defineTool({
  name: "catalogos",
  description:
    "Listas de referencia de la cuenta HiringRoom: pipelines (con sus etapas e ids), clientes, áreas, motivos de rechazo y fuentes de postulantes. Usalo para conocer ids y nombres válidos antes de filtrar.",
  input: { tipo: z.enum(["pipelines", "clientes", "areas", "motivos_rechazo", "fuentes"]) },
  async run({ tipo }, ctx) {
    if (tipo === "pipelines") {
      const items = await getPipelines(ctx.hr, ctx.cache);
      return { tipo, total: items.length, items };
    }
    const path = SOURCES[tipo];
    const raw = await ctx.cache.get(`catalogo:${tipo}`, () => ctx.hr.get(path));
    const list = firstArray(raw);
    const items = list.length || !raw || typeof raw !== "object" ? list : [raw];
    return { tipo, total: items.length, items };
  },
});
```

`src/tools/index.ts`:
```ts
import { catalogos } from "./catalogos.js";
import type { ToolDef } from "./define.js";

export const ALL_TOOLS: ToolDef<any>[] = [catalogos];
```

`src/server.ts`:
```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Audit } from "./audit.js";
import type { ToolContext } from "./tools/context.js";
import { registerTool } from "./tools/define.js";
import { ALL_TOOLS } from "./tools/index.js";

export function createServer(ctx: ToolContext, audit: Audit): McpServer {
  const server = new McpServer({ name: "hiringroom", version: "0.1.0" });
  for (const def of ALL_TOOLS) registerTool(server, ctx, audit, def);
  return server;
}
```

`src/index.ts`:
```ts
#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createFileAudit } from "./audit.js";
import { ConfigError, loadConfig } from "./config.js";
import { assertPdftotext } from "./cv/extract.js";
import { TtlCache } from "./hr/catalog.js";
import { HrClient } from "./hr/client.js";
import { logError } from "./log.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  await assertPdftotext();
  // Login is lazy (first tool call), so bad credentials surface as a tool error, not a crash.
  const hr = new HrClient({ credentials: config.hr, concurrency: config.limits.concurrency, timeoutMs: config.limits.requestTimeoutMs });
  const ctx = { hr, cache: new TtlCache(config.limits.cacheTtlMs), limits: config.limits, now: () => new Date() };
  const server = createServer(ctx, createFileAudit(config.auditDir));
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  logError(err instanceof ConfigError ? err.message : "fallo al iniciar", err instanceof ConfigError ? undefined : { error: String(err) });
  process.exit(1);
});
```

- [ ] **Step 5: Run tests, typecheck and build**

Run: `npx vitest run && npx tsc --noEmit && npm run build`
Expected: all tests PASS; `dist/index.js` exists.

If `registerTool`'s `inputSchema` type rejects a Zod raw shape in the installed SDK version, check the SDK's `McpServer.registerTool` signature in `node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.d.ts` and adapt only `registerTool` in `define.ts`; do not change tool definitions.

- [ ] **Step 6: Startup smoke (no network)**

Run: `HIRINGROOM_ENV_FILE=/nonexistent node dist/index.js; echo "exit=$?"`
Expected: stderr `[hiringroom-mcp] no se encontró el archivo de secretos: /nonexistent`, `exit=1`.

- [ ] **Step 7: Commit**

```bash
git add src/tools src/server.ts src/index.ts test/helpers/harness.ts test/catalogos.test.ts test/define.test.ts
git commit -m "feat: add MCP server, tool wrapper and catalogos tool"
```

---

### Task 10: `buscar_vacantes` and `ver_vacante`

**Files:**
- Create: `src/tools/buscar-vacantes.ts`, `src/tools/ver-vacante.ts`
- Modify: `src/tools/index.ts`
- Test: `test/vacantes.test.ts`

**Interfaces:**
- Consumes: `defineTool`, `isoDate`, `limite`, `pagina`, `orNotFound`, `settle`, `unwrap`, `enc` (Task 9); `fetchAll`, `firstArray` (Task 4); `getPipelines`, `stageName` (Task 4); `vacancySummary`, `vacancyDetail` (Task 5); `assertRange`, `epochStart`, `epochEnd` (Task 2); `normalize` (Task 4); `UpstreamError` (Task 1); `arr`, `num` (Task 5)
- Produces: tools `buscar_vacantes`, `ver_vacante`

- [ ] **Step 1: Write the failing tests**

`test/vacantes.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { UpstreamError } from "../src/errors.js";
import { pipelinesRaw, vacancyRaw } from "./fixtures.js";
import { connect, FakeHr } from "./helpers/harness.js";

const V = "6a0000000000000000000001";

describe("buscar_vacantes", () => {
  it("maps filters to HiringRoom params and returns summaries", async () => {
    const hr = new FakeHr({ "/vacancies": { total: 25, totalPaginas: 2, page: 0, pageSize: 20, vacantes: [vacancyRaw()] } });
    const t = await connect(hr);
    const r = await t.call("buscar_vacantes", { estado: ["Activa"], creada_desde: "2026-08-01", creada_hasta: "2026-08-31" });
    expect(hr.calls[0].query).toMatchObject({ listStatus: "Activa", createdFrom: 1785553200, createdTo: 1788231599, page: 0, pageSize: 20 });
    expect(r.json).toMatchObject({ total: 25, pagina: 1, hay_mas: true });
    expect(r.json.items[0]).toMatchObject({ id: V, estado: "Activa", cliente: "Operadora Sur" });
    expect(r.json.items[0].descripcion).toBeUndefined();
  });

  it("filters by name text across pages", async () => {
    const all = [vacancyRaw({ id: "a", nombre: "Soldador" }), vacancyRaw({ id: "b", nombre: "Chofer" }), vacancyRaw({ id: "c", nombre: "Ayudante de SOLDADURA" })];
    const hr = new FakeHr({ "/vacancies": { total: 3, totalPaginas: 1, vacantes: all } });
    const t = await connect(hr);
    const r = await t.call("buscar_vacantes", { texto: "sóldad" });
    expect(r.json.items.map((v: any) => v.id)).toEqual(["a", "c"]);
    expect(r.json).toMatchObject({ total: 2, completo: true });
  });

  it("rejects inverted ranges", async () => {
    const t = await connect(new FakeHr({}));
    const r = await t.call("buscar_vacantes", { creada_desde: "2026-09-10", creada_hasta: "2026-09-01" });
    expect(r).toMatchObject({ isError: true });
    expect(r.text).toMatch(/posterior/);
  });
});

describe("ver_vacante", () => {
  const routes = {
    [`/vacancies/${V}`]: vacancyRaw(),
    [`/vacancies/${V}/pipeline/counts`]: { total: 12, pipeline: { total: 10, stage: [{ id: 0, total: 6 }, { id: 7, total: 4 }] }, rejecteds: { total: 2, stage: [] } },
    [`/vacancies/${V}/notes`]: { result: [{ nota: "Priorizar Añelo" }] },
    [`/vacancies/${V}/questions`]: { preguntas: [{ pregunta: "¿Carnet?" }] },
    [`/vacancies/${V}/requirements`]: { requisitos: [{ nombre: "Secundario" }] },
    "/pipeline/": pipelinesRaw(),
  };

  it("returns detail, stage counts by name, notes and questions", async () => {
    const t = await connect(new FakeHr(routes));
    const r = await t.call("ver_vacante", { id: V });
    expect(r.json.vacante).toMatchObject({ id: V, descripcion: "Soldadura en planta de tratamiento." });
    expect(r.json.pipeline).toEqual({ total: 10, rechazados: 2, etapas: [{ etapa: "NUEVO", cantidad: 6 }, { etapa: "PRESENTADO", cantidad: 4 }] });
    expect(r.json.notas).toEqual([{ nota: "Priorizar Añelo" }]);
    expect(r.json.estadisticas).toBeUndefined();
  });

  it("stats are opt-in and degrade on timeout", async () => {
    const t = await connect(new FakeHr({ ...routes, [`/vacancies/${V}/stats`]: () => new UpstreamError("timeout") }));
    const r = await t.call("ver_vacante", { id: V, incluir_estadisticas: true });
    expect(r.json.estadisticas).toBe("no disponible (timeout)");
  });

  it("reports missing vacancies clearly and keeps partial sections", async () => {
    const t = await connect(new FakeHr({ "/pipeline/": pipelinesRaw() }));
    const r = await t.call("ver_vacante", { id: "zzz" });
    expect(r).toMatchObject({ isError: true, text: "no existe vacante `zzz`" });

    const partial = { ...routes };
    delete (partial as Record<string, unknown>)[`/vacancies/${V}/notes`];
    const t2 = await connect(new FakeHr(partial));
    const r2 = await t2.call("ver_vacante", { id: V });
    expect(r2.json.advertencias.join()).toMatch(/notas/);
  });
});
```

(`1785553200` = 2026-08-01T00:00:00-03:00; `1788231599` = 2026-08-31T23:59:59-03:00.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/vacantes.test.ts`
Expected: FAIL — tools not registered (`isError` / unknown tool).

- [ ] **Step 3: Implement**

`src/tools/buscar-vacantes.ts`:
```ts
import { z } from "zod";
import { assertRange, epochEnd, epochStart } from "../hr/dates.js";
import { fetchAll, firstArray } from "../hr/paginate.js";
import { vacancySummary } from "../shape/vacancy.js";
import { normalize } from "../text.js";
import { defineTool, isoDate, limite, pagina } from "./define.js";

const TEXT_SCAN_MAX = 1000;

export const buscarVacantes = defineTool({
  name: "buscar_vacantes",
  description:
    "Busca vacantes (búsquedas laborales) de la cuenta. Filtros: estado (ej. Activa, Cerrada), cliente o área, rango de fecha de creación (YYYY-MM-DD) y texto en el nombre. Devuelve un resumen por vacante; usá ver_vacante para el detalle y los contadores del pipeline.",
  input: {
    estado: z.array(z.string()).optional().describe("estados, ej. [\"Activa\"]"),
    cliente_o_area_id: z.string().optional(),
    creada_desde: isoDate.optional(),
    creada_hasta: isoDate.optional(),
    texto: z.string().min(2).optional().describe("texto a buscar en el nombre de la vacante"),
    limite,
    pagina,
  },
  async run(a, ctx) {
    if (a.creada_desde && a.creada_hasta) assertRange(a.creada_desde, a.creada_hasta);
    const query = {
      listStatus: a.estado?.join(","),
      areaOrCustomerId: a.cliente_o_area_id,
      createdFrom: a.creada_desde ? epochStart(a.creada_desde) : undefined,
      createdTo: a.creada_hasta ? epochEnd(a.creada_hasta) : undefined,
    };

    if (!a.texto) {
      const body = await ctx.hr.get("/vacancies", { ...query, page: a.pagina - 1, pageSize: a.limite });
      const items = firstArray(body).map(vacancySummary);
      const totalPaginas = typeof body?.totalPaginas === "number" ? body.totalPaginas : 1;
      return { total: body?.total ?? items.length, pagina: a.pagina, hay_mas: a.pagina < totalPaginas, items };
    }

    const scan = await fetchAll(ctx.hr, "/vacancies", query, TEXT_SCAN_MAX);
    const q = normalize(a.texto);
    const matched = scan.items.filter((v) => normalize(String(v?.nombre ?? "")).includes(q)).map(vacancySummary);
    const start = (a.pagina - 1) * a.limite;
    return {
      total: matched.length,
      pagina: a.pagina,
      hay_mas: start + a.limite < matched.length,
      completo: scan.completo,
      advertencias: scan.advertencias,
      items: matched.slice(start, start + a.limite),
    };
  },
});
```

`src/tools/ver-vacante.ts`:
```ts
import { z } from "zod";
import { UpstreamError } from "../errors.js";
import { getPipelines, stageName, type Pipeline } from "../hr/catalog.js";
import { firstArray } from "../hr/paginate.js";
import { arr, num } from "../shape/common.js";
import { vacancyDetail } from "../shape/vacancy.js";
import { defineTool, enc, orNotFound, settle } from "./define.js";

function stageCounts(counts: any, pipelines: Pipeline[], pipelineId?: string) {
  const etapas = arr(counts?.pipeline?.stage).map((s: any) => {
    const id = num(s?.id ?? s?.stage ?? s?.etapa ?? s?.idEtapa);
    const cantidad = num(s?.total ?? s?.count ?? s?.cantidad ?? s?.cantidadPostulantes) ?? 0;
    return { etapa: (id !== undefined && stageName(pipelines, id, pipelineId)) || `etapa ${id ?? "?"}`, cantidad };
  });
  return { total: num(counts?.pipeline?.total) ?? num(counts?.total), rechazados: num(counts?.rejecteds?.total), etapas };
}

export const verVacante = defineTool({
  name: "ver_vacante",
  description:
    "Detalle de una vacante: descripción, requisitos, responsables, cantidad de postulantes por etapa del pipeline (con nombres), notas y preguntas. Las estadísticas son opcionales porque HiringRoom tarda en calcularlas.",
  input: {
    id: z.string().min(1),
    incluir_estadisticas: z.boolean().default(false),
  },
  async run({ id, incluir_estadisticas }, ctx) {
    const base = `/vacancies/${enc(id)}`;
    const body = await orNotFound(ctx.hr.get(base), "vacante", id);
    const raw = body?.vacante ?? body?.vacancy ?? body;
    const [pipelines, counts, notas, preguntas, requisitos] = await Promise.all([
      settle(getPipelines(ctx.hr, ctx.cache)),
      settle(ctx.hr.get(`${base}/pipeline/counts`)),
      settle(ctx.hr.get(`${base}/notes`)),
      settle(ctx.hr.get(`${base}/questions`)),
      settle(ctx.hr.get(`${base}/requirements`)),
    ]);
    const advertencias: string[] = [];
    const pick = (name: string, r: { ok: true; value: any } | { ok: false; error: string }) => {
      if (r.ok) return r.value?.result ?? firstArray(r.value);
      advertencias.push(`${name}: ${r.error}`);
      return undefined;
    };

    let estadisticas: unknown;
    if (incluir_estadisticas) {
      try {
        estadisticas = await ctx.hr.get(`${base}/stats`, {}, { timeoutMs: ctx.limits.statsBudgetMs, retries: 0 });
      } catch (err) {
        if (!(err instanceof UpstreamError)) throw err;
        estadisticas = "no disponible (timeout)";
      }
    }

    if (!counts.ok) advertencias.push(`pipeline: ${counts.error}`);
    return {
      vacante: vacancyDetail(raw),
      pipeline: counts.ok ? stageCounts(counts.value, pipelines.ok ? pipelines.value : [], raw?.pipelineId) : undefined,
      notas: pick("notas", notas),
      preguntas: pick("preguntas", preguntas),
      requisitos_detalle: pick("requisitos", requisitos),
      estadisticas,
      advertencias,
    };
  },
});
```

`src/tools/index.ts` — replace the file:
```ts
import { buscarVacantes } from "./buscar-vacantes.js";
import { catalogos } from "./catalogos.js";
import type { ToolDef } from "./define.js";
import { verVacante } from "./ver-vacante.js";

export const ALL_TOOLS: ToolDef<any>[] = [buscarVacantes, verVacante, catalogos];
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/buscar-vacantes.ts src/tools/ver-vacante.ts src/tools/index.ts test/vacantes.test.ts
git commit -m "feat: add buscar_vacantes and ver_vacante tools"
```

---

### Task 11: `buscar_postulantes` and `ver_postulante`

**Files:**
- Create: `src/tools/buscar-postulantes.ts`, `src/tools/ver-postulante.ts`
- Modify: `src/tools/index.ts`
- Test: `test/postulantes.test.ts`

**Interfaces:**
- Consumes: `defineTool`, `isoDate`, `limite`, `pagina`, `orNotFound`, `settle`, `unwrap`, `enc` (Task 9); `getPipelines`, `resolveStage` (Task 4); `firstArray` (Task 4); `postulantSummary`, `postulantProfile` (Task 5); `assertRange`, `epochStart`, `epochEnd` (Task 2); `label` (Task 5)
- Produces: tools `buscar_postulantes`, `ver_postulante`; `stageQuery(etapa: string | undefined, ctx: ToolContext): Promise<number | undefined>` exported from `buscar-postulantes.ts` (reused by Task 13)

- [ ] **Step 1: Write the failing tests**

`test/postulantes.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { pipelinesRaw, postulantRaw } from "./fixtures.js";
import { connect, FakeHr } from "./helpers/harness.js";

const P = "6b0000000000000000000001";

describe("buscar_postulantes", () => {
  it("resolves stage names and maps filters", async () => {
    const hr = new FakeHr({
      "/pipeline/": pipelinesRaw(),
      "/postulants/": { total: 1, totalPaginas: 1, curriculums: [postulantRaw()] },
    });
    const t = await connect(hr);
    const r = await t.call("buscar_postulantes", { vacante_id: "v1", etapa: "entrevista", desde: "2026-09-01", hasta: "2026-09-01" });
    const q = hr.calls.find((c) => c.path === "/postulants/")!.query;
    expect(q).toMatchObject({ vacancyId: "v1", stage: 2, createdFrom: 1788231600, createdTo: 1788317999, page: 0, pageSize: 20 });
    expect(r.json).toMatchObject({ total: 1, pagina: 1, hay_mas: false });
    expect(r.json.items[0]).toMatchObject({ id: P, nombre_completo: "Juan Pérez" });
    expect(r.text).not.toContain("30000000");
  });

  it("lists valid stages on an unknown stage name", async () => {
    const t = await connect(new FakeHr({ "/pipeline/": pipelinesRaw() }));
    const r = await t.call("buscar_postulantes", { etapa: "psicotécnico" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Etapas válidas: .*ENTREVISTA/);
  });
});

describe("ver_postulante", () => {
  const routes = {
    [`/postulants/${P}`]: { postulant: { ...postulantRaw(), comentarios: [{ texto: "Buen perfil" }], conocimientos: [{ nombre: "TIG" }] } },
    [`/postulants/${P}/records`]: { records: [{ idVacante: "v1", descripcion: "Pasó a Entrevista", fechaCreacion: "21-09-2026", horaCreacion: "10:00" }] },
    [`/postulants/${P}/files`]: { result: "success", archivos: [{ fileId: "f1.pdf", description: "no especificado" }] },
  };

  it("returns profile, records and files without sensitive fields by default", async () => {
    const t = await connect(new FakeHr(routes));
    const r = await t.call("ver_postulante", { id: P });
    expect(r.json.postulante).toMatchObject({ nombre_completo: "Juan Pérez", telefonoCelular: "+5429911111", comentarios: [{ texto: "Buen perfil" }] });
    expect(r.json.registros[0]).toMatchObject({ descripcion: "Pasó a Entrevista" });
    expect(r.json.archivos).toEqual([{ file_id: "f1.pdf", descripcion: "no especificado" }]);
    expect(r.text).not.toContain("30000000");
    expect(r.text).not.toContain("Masculino");
  });

  it("includes dni and birth date only when asked", async () => {
    const t = await connect(new FakeHr(routes));
    const r = await t.call("ver_postulante", { id: P, incluir_sensibles: true });
    expect(r.json.postulante).toMatchObject({ dni: "30000000", fechaNacimiento: "01-01-1990" });
    expect(r.text).not.toContain("Masculino");
  });

  it("reports missing postulants", async () => {
    const t = await connect(new FakeHr({}));
    expect(await t.call("ver_postulante", { id: "nope" })).toMatchObject({ isError: true, text: "no existe postulante `nope`" });
  });
});
```

(`1788231600` = 2026-09-01T00:00:00-03:00.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/postulantes.test.ts`
Expected: FAIL — tools not registered.

- [ ] **Step 3: Implement**

`src/tools/buscar-postulantes.ts`:
```ts
import { z } from "zod";
import { getPipelines, resolveStage } from "../hr/catalog.js";
import { assertRange, epochEnd, epochStart } from "../hr/dates.js";
import { firstArray } from "../hr/paginate.js";
import { postulantSummary } from "../shape/postulant.js";
import type { ToolContext } from "./context.js";
import { defineTool, isoDate, limite, pagina } from "./define.js";

export async function stageQuery(etapa: string | undefined, ctx: ToolContext): Promise<number | undefined> {
  if (!etapa) return undefined;
  return resolveStage(await getPipelines(ctx.hr, ctx.cache), etapa);
}

export const buscarPostulantes = defineTool({
  name: "buscar_postulantes",
  description:
    "Busca postulaciones por vacante, nombre, apellido, email, etapa del pipeline (nombre como \"Entrevista\" o id), estado y rango de fecha de postulación (YYYY-MM-DD). Devuelve un resumen por postulante (último puesto, años de experiencia, estudio, ubicación). Para buscar por perfil/experiencia usá buscar_por_perfil.",
  input: {
    vacante_id: z.string().optional(),
    nombre: z.string().optional(),
    apellido: z.string().optional(),
    email: z.string().optional(),
    etapa: z.string().optional().describe("nombre de etapa (ej. Entrevista) o id numérico"),
    estado: z.string().optional(),
    desde: isoDate.optional().describe("fecha de postulación desde"),
    hasta: isoDate.optional().describe("fecha de postulación hasta"),
    limite,
    pagina,
  },
  async run(a, ctx) {
    if (a.desde && a.hasta) assertRange(a.desde, a.hasta);
    const body = await ctx.hr.get("/postulants/", {
      vacancyId: a.vacante_id,
      nombre: a.nombre,
      apellido: a.apellido,
      email: a.email,
      stage: await stageQuery(a.etapa, ctx),
      status: a.estado,
      createdFrom: a.desde ? epochStart(a.desde) : undefined,
      createdTo: a.hasta ? epochEnd(a.hasta) : undefined,
      page: a.pagina - 1,
      pageSize: a.limite,
    });
    const now = ctx.now();
    const items = firstArray(body).map((r) => postulantSummary(r, now));
    const totalPaginas = typeof body?.totalPaginas === "number" ? body.totalPaginas : 1;
    return { total: body?.total ?? items.length, pagina: a.pagina, hay_mas: a.pagina < totalPaginas, items };
  },
});
```

`src/tools/ver-postulante.ts`:
```ts
import { z } from "zod";
import { firstArray } from "../hr/paginate.js";
import { label } from "../shape/common.js";
import { postulantProfile } from "../shape/postulant.js";
import { defineTool, enc, orNotFound, settle, unwrap } from "./define.js";

export const verPostulante = defineTool({
  name: "ver_postulante",
  description:
    "Perfil completo de un postulante: experiencia, estudios, conocimientos, comentarios, referencias, disponibilidad, historial (records) y lista de archivos adjuntos con su file_id (para leer_cv). DNI, CUIL y fecha de nacimiento solo con incluir_sensibles: true.",
  input: {
    id: z.string().min(1),
    incluir_sensibles: z.boolean().default(false),
  },
  async run({ id, incluir_sensibles }, ctx) {
    const base = `/postulants/${enc(id)}`;
    const raw = unwrap(await orNotFound(ctx.hr.get(base), "postulante", id), "postulant", "postulante");
    const [records, files] = await Promise.all([settle(ctx.hr.get(`${base}/records`)), settle(ctx.hr.get(`${base}/files`))]);
    const advertencias: string[] = [];
    if (!records.ok) advertencias.push(`registros: ${records.error}`);
    if (!files.ok) advertencias.push(`archivos: ${files.error}`);
    return {
      postulante: postulantProfile(raw, ctx.now(), incluir_sensibles),
      registros: records.ok ? (records.value?.records ?? firstArray(records.value)) : undefined,
      archivos: files.ok
        ? (files.value?.archivos ?? firstArray(files.value)).map((f: any) => ({ file_id: label(f?.fileId), descripcion: label(f?.description) }))
        : undefined,
      advertencias,
    };
  },
});
```

`src/tools/index.ts` — replace the file:
```ts
import { buscarPostulantes } from "./buscar-postulantes.js";
import { buscarVacantes } from "./buscar-vacantes.js";
import { catalogos } from "./catalogos.js";
import type { ToolDef } from "./define.js";
import { verPostulante } from "./ver-postulante.js";
import { verVacante } from "./ver-vacante.js";

export const ALL_TOOLS: ToolDef<any>[] = [buscarVacantes, verVacante, buscarPostulantes, verPostulante, catalogos];
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/buscar-postulantes.ts src/tools/ver-postulante.ts src/tools/index.ts test/postulantes.test.ts
git commit -m "feat: add buscar_postulantes and ver_postulante tools"
```

---

### Task 12: `leer_cv`

**Files:**
- Create: `src/tools/leer-cv.ts`
- Modify: `src/tools/index.ts`
- Test: `test/leer-cv.test.ts`

**Interfaces:**
- Consumes: `defineTool`, `enc`, `orNotFound` (Task 9); `detectKind`, `extractText`, `truncate` (Task 7); `firstArray` (Task 4); `InputError` (Task 1); `ToolContext` (Task 9)
- Produces: tool `leer_cv`; `fetchCvText(ctx: ToolContext, postulanteId: string, fileId?: string): Promise<{ fileId: string; text: string }>` (reused by Task 13)

- [ ] **Step 1: Write the failing tests**

`test/leer-cv.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { connect, FakeHr } from "./helpers/harness.js";
import { minimalPdf } from "./helpers/pdf.js";

const P = "p1";
const files = (ids: string[]) => ({ [`/postulants/${P}/files`]: { result: "success", archivos: ids.map((fileId) => ({ fileId, description: "no especificado" })) } });
const pdf = { contentType: "application/pdf", bytes: minimalPdf("Soldador calificado con certificacion API 1104") };
const gif = { contentType: "image/gif", bytes: Buffer.from("GIF89a....") };

describe("leer_cv", () => {
  it("reads the first PDF/DOCX attachment, skipping others", async () => {
    const hr = new FakeHr(files(["foto.gif", "cv.pdf"]), { [`/postulants/${P}/file/foto.gif`]: gif, [`/postulants/${P}/file/cv.pdf`]: pdf });
    const t = await connect(hr);
    const r = await t.call("leer_cv", { postulante_id: P });
    expect(r.json).toMatchObject({ postulante_id: P, file_id: "cv.pdf", truncado: false });
    expect(r.json.texto).toContain("API 1104");
  });

  it("truncates to max_caracteres", async () => {
    const t = await connect(new FakeHr(files(["cv.pdf"]), { [`/postulants/${P}/file/cv.pdf`]: pdf }));
    const r = await t.call("leer_cv", { postulante_id: P, max_caracteres: 1000 });
    expect(r.json.truncado).toBe(false);
    const r2 = await (await connect(new FakeHr(files(["cv.pdf"]), { [`/postulants/${P}/file/cv.pdf`]: pdf }), { limits: { cvMaxChars: 10 } })).call("leer_cv", { postulante_id: P });
    expect(r2.json).toMatchObject({ truncado: true });
    expect(r2.json.texto).toHaveLength(10);
  });

  it("errors clearly when there is nothing readable", async () => {
    const none = await connect(new FakeHr(files([])));
    expect(await none.call("leer_cv", { postulante_id: P })).toMatchObject({ isError: true, text: "el postulante no tiene archivos adjuntos" });
    const onlyGif = await connect(new FakeHr(files(["foto.gif"]), { [`/postulants/${P}/file/foto.gif`]: gif }));
    expect(await onlyGif.call("leer_cv", { postulante_id: P })).toMatchObject({ isError: true, text: "ningún adjunto es PDF o DOCX" });
    const explicit = await connect(new FakeHr(files(["foto.gif"]), { [`/postulants/${P}/file/foto.gif`]: gif }));
    expect((await explicit.call("leer_cv", { postulante_id: P, file_id: "foto.gif" })).text).toMatch(/no soportado/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/leer-cv.test.ts`
Expected: FAIL — tool not registered.

- [ ] **Step 3: Implement `src/tools/leer-cv.ts`**

```ts
import { z } from "zod";
import { detectKind, extractText, truncate } from "../cv/extract.js";
import { InputError } from "../errors.js";
import { firstArray } from "../hr/paginate.js";
import type { ToolContext } from "./context.js";
import { defineTool, enc, orNotFound } from "./define.js";

const MAX_ATTEMPTS = 5;

export async function fetchCvText(ctx: ToolContext, postulanteId: string, fileId?: string): Promise<{ fileId: string; text: string }> {
  const base = `/postulants/${enc(postulanteId)}`;
  let candidates: string[];
  if (fileId) candidates = [fileId];
  else {
    const body = await orNotFound(ctx.hr.get(`${base}/files`), "postulante", postulanteId);
    candidates = (body?.archivos ?? firstArray(body)).map((f: any) => String(f?.fileId ?? "")).filter(Boolean);
  }
  if (!candidates.length) throw new InputError("el postulante no tiene archivos adjuntos");

  for (const fid of candidates.slice(0, MAX_ATTEMPTS)) {
    const bin = await orNotFound(ctx.hr.getBinary(`${base}/file/${enc(fid)}`, ctx.limits.cvMaxBytes), "archivo", fid);
    if (detectKind(bin.bytes) === "otro" && !fileId) continue;
    return { fileId: fid, text: await extractText(bin.bytes) };
  }
  throw new InputError("ningún adjunto es PDF o DOCX");
}

export const leerCv = defineTool({
  name: "leer_cv",
  description:
    "Descarga el CV adjunto de un postulante (PDF o DOCX) y devuelve su texto. Sin file_id toma el primer adjunto legible. Los file_id salen de ver_postulante.",
  input: {
    postulante_id: z.string().min(1),
    file_id: z.string().optional(),
    max_caracteres: z.number().int().min(1000).max(60_000).optional().describe("por defecto 20000"),
  },
  maxBytes: (limits) => limits.cvMaxChars * 4 + 2000,
  async run({ postulante_id, file_id, max_caracteres }, ctx) {
    const max = Math.min(max_caracteres ?? ctx.limits.cvDefaultChars, ctx.limits.cvMaxChars);
    const { fileId, text } = await fetchCvText(ctx, postulante_id, file_id);
    const { texto, truncado } = truncate(text, max);
    return { postulante_id, file_id: fileId, caracteres: text.length, truncado, texto };
  },
});
```

`src/tools/index.ts` — replace the file:
```ts
import { buscarPostulantes } from "./buscar-postulantes.js";
import { buscarVacantes } from "./buscar-vacantes.js";
import { catalogos } from "./catalogos.js";
import type { ToolDef } from "./define.js";
import { leerCv } from "./leer-cv.js";
import { verPostulante } from "./ver-postulante.js";
import { verVacante } from "./ver-vacante.js";

export const ALL_TOOLS: ToolDef<any>[] = [buscarVacantes, verVacante, buscarPostulantes, verPostulante, leerCv, catalogos];
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/leer-cv.ts src/tools/index.ts test/leer-cv.test.ts
git commit -m "feat: add leer_cv tool"
```

---

### Task 13: `buscar_por_perfil`

**Files:**
- Create: `src/tools/buscar-por-perfil.ts`
- Modify: `src/tools/index.ts`
- Test: `test/buscar-por-perfil.test.ts`

**Interfaces:**
- Consumes: `defineTool`, `isoDate`, `errorMessage` (Task 9); `stageQuery` (Task 11); `fetchCvText` (Task 12); `fetchAll` (Task 4); `rank` (Task 6); `postulantSummary` (Task 5); `assertRange`, `epochStart`, `epochEnd` (Task 2); `InputError` (Task 1)
- Produces: tool `buscar_por_perfil`

- [ ] **Step 1: Write the failing tests**

`test/buscar-por-perfil.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { pipelinesRaw, postulantRaw } from "./fixtures.js";
import { connect, FakeHr } from "./helpers/harness.js";
import { minimalPdf } from "./helpers/pdf.js";

const blank = { experienciasLaborales: [], estudios: [], tags: [], direccion: {}, presentacionPostulante: "" };

function pool() {
  return [
    postulantRaw({ id: "A" }),
    postulantRaw({ id: "B", ...blank, presentacionPostulante: "soldador aprendiz" }),
    postulantRaw({ id: "C", ...blank, presentacionPostulante: "chofer" }),
    postulantRaw({ id: "D", ...blank }),
  ];
}

describe("buscar_por_perfil", () => {
  it("requires a scope", async () => {
    const t = await connect(new FakeHr({}));
    const r = await t.call("buscar_por_perfil", { palabras: ["soldador"] });
    expect(r).toMatchObject({ isError: true });
    expect(r.text).toMatch(/acotá por vacante o fechas/);
  });

  it("ranks matches in a vacancy with reasons and scan counts", async () => {
    const hr = new FakeHr({ "/postulants/": { total: 4, totalPaginas: 1, curriculums: pool() } });
    const t = await connect(hr);
    const r = await t.call("buscar_por_perfil", { palabras: ["soldador", "neuquen"], vacante_id: "v1" });
    expect(hr.calls[0].query).toMatchObject({ vacancyId: "v1", page: 0, pageSize: 100 });
    expect(r.json).toMatchObject({ escaneados: 4, total_en_alcance: 4, total_coincidencias: 2, completo: true });
    expect(r.json.items.map((x: any) => x.id)).toEqual(["A", "B"]);
    expect(r.json.items[0]).toMatchObject({ score: 4, coincidencias: [{ palabra: "soldador", campo: "puesto" }, { palabra: "neuquen", campo: "ubicacion" }] });
    expect(r.text).not.toContain("30000000");
  });

  it("uses a date range and stage, and flags partial scans", async () => {
    const hr = new FakeHr({
      "/pipeline/": pipelinesRaw(),
      "/postulants/": (q: Record<string, unknown>) => ({ total: 5000, totalPaginas: 50, curriculums: q.page === 0 ? pool() : [] }),
    });
    const t = await connect(hr, { limits: { perfilMaxScan: 200 } });
    const r = await t.call("buscar_por_perfil", { palabras: ["soldador"], desde: "2026-08-01", hasta: "2026-08-31", etapa: "Entrevista" });
    expect(hr.calls.find((c) => c.path === "/postulants/")!.query).toMatchObject({ stage: 2, createdFrom: 1785553200 });
    expect(r.json.completo).toBe(false);
    expect(r.json.total_en_alcance).toBe(5000);
    expect(r.json.advertencias.join()).toMatch(/de 5000/);
  });

  it("re-scores the top matches with CV text when incluir_cv", async () => {
    const hr = new FakeHr(
      {
        "/postulants/": { total: 2, totalPaginas: 1, curriculums: [postulantRaw({ id: "B", ...blank, presentacionPostulante: "soldador" }), postulantRaw({ id: "E", ...blank, presentacionPostulante: "soldador" })] },
        "/postulants/B/files": { archivos: [{ fileId: "b.pdf" }] },
        "/postulants/E/files": { archivos: [] },
      },
      { "/postulants/B/file/b.pdf": { contentType: "application/pdf", bytes: minimalPdf("Soldador TIG certificado") } },
    );
    const t = await connect(hr);
    const r = await t.call("buscar_por_perfil", { palabras: ["soldador", "tig"], vacante_id: "v1", incluir_cv: true });
    expect(r.json.items[0]).toMatchObject({ id: "B", score: 2 });
    expect(r.json.advertencias.join()).toMatch(/1 CV/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/buscar-por-perfil.test.ts`
Expected: FAIL — tool not registered.

- [ ] **Step 3: Implement `src/tools/buscar-por-perfil.ts`**

```ts
import { z } from "zod";
import { InputError } from "../errors.js";
import { assertRange, epochEnd, epochStart } from "../hr/dates.js";
import { fetchAll } from "../hr/paginate.js";
import { rank } from "../search/perfil.js";
import { postulantSummary } from "../shape/postulant.js";
import { stageQuery } from "./buscar-postulantes.js";
import { defineTool, isoDate } from "./define.js";
import { fetchCvText } from "./leer-cv.js";

export const buscarPorPerfil = defineTool({
  name: "buscar_por_perfil",
  description:
    "Búsqueda cruzada de candidatos por perfil (ej. soldadores con experiencia en Neuquén). Requiere acotar por vacante_id o por rango de fecha de postulación (desde + hasta). Busca las palabras (sin importar tildes/mayúsculas, por prefijo; admite frases) en puestos, áreas, descripciones, estudios, tags, presentación y ubicación; opcionalmente también en el texto de los CVs de los mejores resultados. Devuelve un ranking con el motivo de cada coincidencia y cuántos postulantes se escanearon.",
  input: {
    palabras: z.array(z.string().min(2)).min(1).max(20),
    excluir: z.array(z.string().min(2)).max(20).optional(),
    vacante_id: z.string().optional(),
    desde: isoDate.optional(),
    hasta: isoDate.optional(),
    etapa: z.string().optional(),
    max_escanear: z.number().int().min(10).max(1000).optional().describe("por defecto 1000"),
    incluir_cv: z.boolean().default(false).describe("lee los CV del top 30 (más lento)"),
    limite: z.number().int().min(1).max(50).default(20),
  },
  async run(a, ctx) {
    if (!a.vacante_id && !(a.desde && a.hasta)) {
      throw new InputError("acotá por vacante o fechas: pasá vacante_id, o desde + hasta");
    }
    if (a.desde && a.hasta) assertRange(a.desde, a.hasta);
    const deadline = Date.now() + ctx.limits.perfilBudgetMs;
    const maxScan = Math.min(a.max_escanear ?? ctx.limits.perfilMaxScan, ctx.limits.perfilMaxScan);

    const scan = await fetchAll(
      ctx.hr,
      "/postulants/",
      {
        vacancyId: a.vacante_id,
        stage: await stageQuery(a.etapa, ctx),
        createdFrom: a.desde ? epochStart(a.desde) : undefined,
        createdTo: a.hasta ? epochEnd(a.hasta) : undefined,
      },
      maxScan,
      { deadline },
    );
    const advertencias = [...scan.advertencias];
    let completo = scan.completo;
    let ranked = rank(scan.items, a.palabras, a.excluir);

    if (a.incluir_cv && ranked.length) {
      const top = ranked.slice(0, ctx.limits.perfilCvTop);
      const cvById = new Map<string, string>();
      let fallidos = 0;
      let omitidos = 0;
      await Promise.all(
        top.map(async (r) => {
          if (Date.now() > deadline) {
            omitidos++;
            return;
          }
          try {
            cvById.set(String(r.raw.id), (await fetchCvText(ctx, String(r.raw.id))).text);
          } catch {
            fallidos++;
          }
        }),
      );
      if (fallidos) advertencias.push(`${fallidos} CV no se pudieron leer (sin adjunto legible o error)`);
      if (omitidos) {
        completo = false;
        advertencias.push(`${omitidos} CV omitidos por presupuesto de tiempo`);
      }
      ranked = rank(scan.items, a.palabras, a.excluir, cvById);
    }

    const now = ctx.now();
    return {
      escaneados: scan.items.length,
      total_en_alcance: scan.total,
      total_coincidencias: ranked.length,
      completo,
      advertencias,
      items: ranked.slice(0, a.limite).map((r) => ({
        ...postulantSummary(r.raw, now),
        score: r.score,
        coincidencias: r.coincidencias,
        vacantes: r.vacantes,
      })),
    };
  },
});
```

`src/tools/index.ts` — replace the file:
```ts
import { buscarPorPerfil } from "./buscar-por-perfil.js";
import { buscarPostulantes } from "./buscar-postulantes.js";
import { buscarVacantes } from "./buscar-vacantes.js";
import { catalogos } from "./catalogos.js";
import type { ToolDef } from "./define.js";
import { leerCv } from "./leer-cv.js";
import { verPostulante } from "./ver-postulante.js";
import { verVacante } from "./ver-vacante.js";

export const ALL_TOOLS: ToolDef<any>[] = [
  buscarVacantes,
  verVacante,
  buscarPostulantes,
  verPostulante,
  leerCv,
  buscarPorPerfil,
  catalogos,
];
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/buscar-por-perfil.ts src/tools/index.ts test/buscar-por-perfil.test.ts
git commit -m "feat: add buscar_por_perfil cross-search tool"
```

---

### Task 14: Report tools

**Files:**
- Create: `src/tools/reporte-contrataciones.ts`, `src/tools/reporte-movimientos-vacantes.ts`, `src/tools/postulaciones-por-dia.ts`
- Modify: `src/tools/index.ts`
- Test: `test/reportes.test.ts`

**Interfaces:**
- Consumes: `defineTool`, `isoDate`, `errorMessage` (Task 9); `splitWindows`, `eachDay`, `assertRange`, `toDmy`, `normalizeHrDate`, `type DateWindow` (Task 2); `fetchAll`, `type PageResult` (Task 4); `postulantSummary` (Task 5); `vacancySummary` (Task 5); `label` (Task 5)
- Produces: tools `reporte_contrataciones`, `reporte_movimientos_vacantes`, `postulaciones_por_dia`; helper `fetchWindows(ctx, path, windows, toQuery): Promise<{ items: any[]; completo: boolean; advertencias: string[] }>` exported from `reporte-contrataciones.ts`

- [ ] **Step 1: Write the failing tests**

`test/reportes.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { UpstreamError } from "../src/errors.js";
import { postulantRaw, vacancyRaw } from "./fixtures.js";
import { connect, FakeHr } from "./helpers/harness.js";

describe("reporte_contrataciones", () => {
  it("splits into 30-day windows (DD-MM-YYYY) and totals by vacancy and month", async () => {
    const hr = new FakeHr({
      "/postulants/hired/": (q: Record<string, unknown>) =>
        q.start === "01-07-2026"
          ? { total: 2, totalPaginas: 1, curriculums: [postulantRaw({ id: "h1", fechaContratacion: "05-07-2026" }), postulantRaw({ id: "h2", vacanteId: "v9", vacanteNombre: "Chofer", fechaContratacion: "20-07-2026" })] }
          : { total: 1, totalPaginas: 1, curriculums: [postulantRaw({ id: "h3", fechaContratacion: "02-08-2026" })] },
    });
    const t = await connect(hr);
    const r = await t.call("reporte_contrataciones", { desde: "2026-07-01", hasta: "2026-08-15" });
    expect(hr.calls.map((c) => [c.query.start, c.query.end])).toEqual([["01-07-2026", "30-07-2026"], ["31-07-2026", "15-08-2026"]]);
    expect(r.json).toMatchObject({ total: 3, completo: true });
    expect(r.json.por_vacante).toEqual([{ vacante: "Soldador calificado - Añelo", cantidad: 2 }, { vacante: "Chofer", cantidad: 1 }]);
    expect(r.json.por_mes).toEqual([{ mes: "2026-07", cantidad: 2 }, { mes: "2026-08", cantidad: 1 }]);
    expect(r.json.items[0]).toMatchObject({ id: "h1", fecha_contratacion: "2026-07-05" });
  });

  it("keeps going when a window fails", async () => {
    const hr = new FakeHr({
      "/postulants/hired/": (q: Record<string, unknown>) => (q.start === "01-07-2026" ? new UpstreamError("x") : { total: 0, totalPaginas: 0, curriculums: [] }),
    });
    const r = await (await connect(hr)).call("reporte_contrataciones", { desde: "2026-07-01", hasta: "2026-08-15" });
    expect(r.json.completo).toBe(false);
    expect(r.json.advertencias.join()).toMatch(/01-07-2026/);
  });

  it("caps the range at 365 days", async () => {
    const r = await (await connect(new FakeHr({}))).call("reporte_contrataciones", { desde: "2025-01-01", hasta: "2026-09-01" });
    expect(r.text).toMatch(/365 días/);
  });
});

describe("reporte_movimientos_vacantes", () => {
  it("uses 7-day windows and groups by status", async () => {
    const hr = new FakeHr({
      "/vacancies/byChangedStatus": (q: Record<string, unknown>) =>
        q.start === "01-09-2026"
          ? { total: 2, totalPaginas: 1, vacantes: [vacancyRaw({ id: "a", estadoActual: "Cerrada" }), vacancyRaw({ id: "b", estadoActual: "Activa" })] }
          : { total: 1, totalPaginas: 1, vacantes: [vacancyRaw({ id: "c", estadoActual: "Cerrada" })] },
    });
    const r = await (await connect(hr)).call("reporte_movimientos_vacantes", { desde: "2026-09-01", hasta: "2026-09-10" });
    expect(hr.calls.map((c) => c.query.start)).toEqual(["01-09-2026", "08-09-2026"]);
    expect(r.json.por_estado).toEqual([{ estado: "Cerrada", cantidad: 2 }, { estado: "Activa", cantidad: 1 }]);
    expect(r.json.total).toBe(3);
  });

  it("caps the range at 90 days", async () => {
    const r = await (await connect(new FakeHr({}))).call("reporte_movimientos_vacantes", { desde: "2026-01-01", hasta: "2026-09-01" });
    expect(r.text).toMatch(/90 días/);
  });
});

describe("postulaciones_por_dia", () => {
  it("counts per day and ranks vacancies without returning postulants", async () => {
    const hr = new FakeHr({
      "/postulants/byDay/": (q: Record<string, unknown>) =>
        q.day === "21-09-2026"
          ? { total: 2, totalPaginas: 1, curriculums: [postulantRaw({ id: "x" }), postulantRaw({ id: "y", vacanteId: "v9", vacanteNombre: "Chofer" })] }
          : { total: 1, totalPaginas: 1, curriculums: [postulantRaw({ id: "z" })] },
    });
    const r = await (await connect(hr)).call("postulaciones_por_dia", { desde: "2026-09-21", hasta: "2026-09-22" });
    expect(r.json.por_dia).toEqual([{ fecha: "2026-09-21", cantidad: 2 }, { fecha: "2026-09-22", cantidad: 1 }]);
    expect(r.json.top_vacantes[0]).toEqual({ vacante_id: "6a0000000000000000000001", vacante: "Soldador calificado - Añelo", cantidad: 2 });
    expect(r.json.total).toBe(3);
    expect(r.text).not.toContain("juan.perez@example.com");
  });

  it("caps the range at 31 days", async () => {
    const r = await (await connect(new FakeHr({}))).call("postulaciones_por_dia", { desde: "2026-08-01", hasta: "2026-09-10" });
    expect(r.text).toMatch(/31 días/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/reportes.test.ts`
Expected: FAIL — tools not registered.

- [ ] **Step 3: Implement**

`src/tools/reporte-contrataciones.ts`:
```ts
import { assertRange, normalizeHrDate, splitWindows, toDmy, type DateWindow } from "../hr/dates.js";
import type { Query } from "../hr/client.js";
import { fetchAll } from "../hr/paginate.js";
import { label } from "../shape/common.js";
import { postulantSummary } from "../shape/postulant.js";
import type { ToolContext } from "./context.js";
import { defineTool, errorMessage, isoDate } from "./define.js";

const WINDOW_MAX_ITEMS = 10_000;

export async function fetchWindows(
  ctx: ToolContext,
  path: string,
  windows: DateWindow[],
  toQuery: (w: DateWindow) => Query,
): Promise<{ items: any[]; completo: boolean; advertencias: string[] }> {
  const results = await Promise.allSettled(windows.map((w) => fetchAll(ctx.hr, path, toQuery(w), WINDOW_MAX_ITEMS)));
  const items: any[] = [];
  const advertencias: string[] = [];
  let completo = true;
  results.forEach((r, i) => {
    const w = windows[i];
    if (r.status === "rejected") {
      completo = false;
      advertencias.push(`ventana ${toDmy(w.desde)}..${toDmy(w.hasta)} falló: ${errorMessage(r.reason)}`);
      return;
    }
    items.push(...r.value.items);
    if (!r.value.completo) {
      completo = false;
      advertencias.push(...r.value.advertencias.map((a) => `ventana ${toDmy(w.desde)}..${toDmy(w.hasta)}: ${a}`));
    }
  });
  return { items, completo, advertencias };
}

export function countBy<T>(items: T[], key: (x: T) => string): { clave: string; cantidad: number }[] {
  const m = new Map<string, number>();
  for (const x of items) m.set(key(x), (m.get(key(x)) ?? 0) + 1);
  return [...m.entries()].map(([clave, cantidad]) => ({ clave, cantidad })).sort((a, b) => b.cantidad - a.cantidad);
}

/** Field name for the hire date is not documented; check the smoke output (Task 15) and keep this list in sync. */
function hireDate(raw: any): string | undefined {
  return normalizeHrDate(raw?.fechaContratacion ?? raw?.fechaContratado ?? raw?.fechaIngreso ?? raw?.fechaHire);
}

export const reporteContrataciones = defineTool({
  name: "reporte_contrataciones",
  description:
    "Contrataciones en un rango de fechas (YYYY-MM-DD, máximo 365 días). Devuelve el total, conteos por vacante y por mes, y la lista de contratados (resumen).",
  input: { desde: isoDate, hasta: isoDate },
  async run({ desde, hasta }, ctx) {
    assertRange(desde, hasta, 365);
    const windows = splitWindows(desde, hasta, 30);
    const res = await fetchWindows(ctx, "/postulants/hired/", windows, (w) => ({ start: toDmy(w.desde), end: toDmy(w.hasta) }));
    const now = ctx.now();
    const items = res.items.map((raw) => ({ ...postulantSummary(raw, now), fecha_contratacion: hireDate(raw) }));
    return {
      total: items.length,
      completo: res.completo,
      advertencias: res.advertencias,
      por_vacante: countBy(res.items, (r) => label(r?.vacanteNombre) ?? "sin vacante").map(({ clave, cantidad }) => ({ vacante: clave, cantidad })),
      por_mes: countBy(items, (i) => i.fecha_contratacion?.slice(0, 7) ?? "sin fecha")
        .map(({ clave, cantidad }) => ({ mes: clave, cantidad }))
        .sort((a, b) => a.mes.localeCompare(b.mes)),
      items,
    };
  },
});
```

`src/tools/reporte-movimientos-vacantes.ts`:
```ts
import { assertRange, splitWindows, toDmy } from "../hr/dates.js";
import { vacancySummary } from "../shape/vacancy.js";
import { defineTool, isoDate } from "./define.js";
import { countBy, fetchWindows } from "./reporte-contrataciones.js";

export const reporteMovimientosVacantes = defineTool({
  name: "reporte_movimientos_vacantes",
  description:
    "Vacantes que cambiaron de estado en un rango de fechas (YYYY-MM-DD, máximo 90 días). Devuelve conteos por estado actual y la lista de vacantes (resumen).",
  input: { desde: isoDate, hasta: isoDate },
  async run({ desde, hasta }, ctx) {
    assertRange(desde, hasta, 90);
    const res = await fetchWindows(ctx, "/vacancies/byChangedStatus", splitWindows(desde, hasta, 7), (w) => ({
      start: toDmy(w.desde),
      end: toDmy(w.hasta),
    }));
    const items = res.items.map(vacancySummary);
    return {
      total: items.length,
      completo: res.completo,
      advertencias: res.advertencias,
      por_estado: countBy(items, (v) => v.estado ?? "sin estado").map(({ clave, cantidad }) => ({ estado: clave, cantidad })),
      items,
    };
  },
});
```

`src/tools/postulaciones-por-dia.ts`:
```ts
import { assertRange, eachDay, toDmy } from "../hr/dates.js";
import { fetchAll } from "../hr/paginate.js";
import { label } from "../shape/common.js";
import { defineTool, errorMessage, isoDate } from "./define.js";

const DAY_MAX_ITEMS = 1000;

export const postulacionesPorDia = defineTool({
  name: "postulaciones_por_dia",
  description:
    "Cantidad de postulaciones por día en un rango (YYYY-MM-DD, máximo 31 días) y las 10 vacantes con más postulaciones en ese período. No devuelve datos de postulantes.",
  input: { desde: isoDate, hasta: isoDate },
  async run({ desde, hasta }, ctx) {
    assertRange(desde, hasta, 31);
    const days = eachDay(desde, hasta);
    const results = await Promise.allSettled(days.map((d) => fetchAll(ctx.hr, "/postulants/byDay/", { day: toDmy(d) }, DAY_MAX_ITEMS)));
    const advertencias: string[] = [];
    let completo = true;
    const porVacante = new Map<string, { vacante_id: string; vacante: string; cantidad: number }>();
    const por_dia = results.map((r, i) => {
      if (r.status === "rejected") {
        completo = false;
        advertencias.push(`${days[i]} falló: ${errorMessage(r.reason)}`);
        return { fecha: days[i], cantidad: undefined };
      }
      if (!r.value.completo) {
        completo = false;
        advertencias.push(`${days[i]}: top de vacantes calculado sobre ${r.value.items.length} de ${r.value.total}`);
      }
      for (const raw of r.value.items) {
        const id = label(raw?.vacanteId) ?? "sin vacante";
        const entry = porVacante.get(id) ?? { vacante_id: id, vacante: label(raw?.vacanteNombre) ?? id, cantidad: 0 };
        entry.cantidad++;
        porVacante.set(id, entry);
      }
      return { fecha: days[i], cantidad: r.value.total };
    });
    return {
      total: por_dia.reduce((s, d) => s + (d.cantidad ?? 0), 0),
      completo,
      advertencias,
      por_dia,
      top_vacantes: [...porVacante.values()].sort((a, b) => b.cantidad - a.cantidad).slice(0, 10),
    };
  },
});
```

`src/tools/index.ts` — replace the file:
```ts
import { buscarPorPerfil } from "./buscar-por-perfil.js";
import { buscarPostulantes } from "./buscar-postulantes.js";
import { buscarVacantes } from "./buscar-vacantes.js";
import { catalogos } from "./catalogos.js";
import type { ToolDef } from "./define.js";
import { leerCv } from "./leer-cv.js";
import { postulacionesPorDia } from "./postulaciones-por-dia.js";
import { reporteContrataciones } from "./reporte-contrataciones.js";
import { reporteMovimientosVacantes } from "./reporte-movimientos-vacantes.js";
import { verPostulante } from "./ver-postulante.js";
import { verVacante } from "./ver-vacante.js";

export const ALL_TOOLS: ToolDef<any>[] = [
  buscarVacantes,
  verVacante,
  buscarPostulantes,
  verPostulante,
  leerCv,
  buscarPorPerfil,
  reporteContrataciones,
  reporteMovimientosVacantes,
  postulacionesPorDia,
  catalogos,
];
```

- [ ] **Step 4: Add the tool-list test and run everything**

Append to `test/catalogos.test.ts`:
```ts
describe("server", () => {
  it("exposes exactly the 10 MVP tools", async () => {
    const t = await connect(new FakeHr({}));
    expect(await t.listTools()).toEqual([
      "buscar_por_perfil",
      "buscar_postulantes",
      "buscar_vacantes",
      "catalogos",
      "leer_cv",
      "postulaciones_por_dia",
      "reporte_contrataciones",
      "reporte_movimientos_vacantes",
      "ver_postulante",
      "ver_vacante",
    ]);
  });
});
```

Run: `npx vitest run && npx tsc --noEmit && npm run build`
Expected: all PASS; build OK.

- [ ] **Step 5: Commit**

```bash
git add src/tools test/reportes.test.ts test/catalogos.test.ts
git commit -m "feat: add hiring, vacancy-movement and daily-application report tools"
```

---

### Task 15: Smoke script, README, install and acceptance

**Files:**
- Create: `scripts/smoke.ts`, `README.md`
- Possibly modify (only if the smoke output shows a mismatch): `src/shape/vacancy.ts`, `src/tools/ver-vacante.ts` (`stageCounts`), `src/tools/reporte-contrataciones.ts` (`hireDate`), `src/hr/dates.ts` window sizes, with a matching test update

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Write `scripts/smoke.ts`**

Prints only tool names, timings, error flags, counts and **key names** — never values.

```ts
// Manual read-only check against the real HiringRoom API. Prints counts, timings and key names only.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { memoryAudit } from "../src/audit.js";
import { loadConfig } from "../src/config.js";
import { assertPdftotext } from "../src/cv/extract.js";
import { TtlCache } from "../src/hr/catalog.js";
import { HrClient } from "../src/hr/client.js";
import { addDays } from "../src/hr/dates.js";
import { firstArray } from "../src/hr/paginate.js";
import { createServer } from "../src/server.js";

const keys = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? Object.keys(v).sort() : typeof v);

async function main() {
  const config = loadConfig();
  await assertPdftotext();
  const hr = new HrClient({ credentials: config.hr, concurrency: config.limits.concurrency, timeoutMs: config.limits.requestTimeoutMs });
  const ctx = { hr, cache: new TtlCache(config.limits.cacheTtlMs), limits: config.limits, now: () => new Date() };

  // 1. Raw shapes the shapers guess at (keys only). Failures print the API's validation message, never data.
  const safe = (p: Promise<any>) => p.catch((e: Error) => ({ __error: e.message }));
  const allVacs = firstArray(await safe(hr.get("/vacancies", { page: 0, pageSize: 100 })));
  const vac = allVacs.find((v: any) => v.estadoActual === "Activa") ?? allVacs[0];
  const today = new Date().toISOString().slice(0, 10);
  const dmy = (iso: string) => iso.split("-").reverse().join("-");
  const hiredBody = await safe(hr.get("/postulants/hired/", { start: dmy(addDays(today, -29)), end: dmy(today), page: 0, pageSize: 10 }));
  const moved = await safe(hr.get("/vacancies/byChangedStatus", { start: dmy(addDays(today, -6)), end: dmy(today), page: 0, pageSize: 10 }));
  const counts = vac ? await safe(hr.get(`/vacancies/${vac.id}/pipeline/counts`)) : undefined;
  console.log("vacancy.ubicacion", keys(vac?.ubicacion));
  console.log("vacancy.client", keys(vac?.client));
  console.log("vacancy.usuarios[0]", keys(vac?.usuarios?.[0]));
  console.log("vacancy detail top-level", keys(vac ? await safe(hr.get(`/vacancies/${vac.id}`)) : undefined));
  console.log("pipeline counts", keys(counts), "stage[0]", keys(counts?.pipeline?.stage?.[0]));
  console.log("hired top-level", keys(hiredBody), "item", keys(firstArray(hiredBody)[0]));
  console.log("byChangedStatus top-level", keys(moved));
  console.log("estados de vacantes (valores de estadoActual, no personales)", [...new Set(allVacs.map((v: any) => v.estadoActual))]);
  console.log("listStatus=Activa", keys(await safe(hr.get("/vacancies", { page: 0, pageSize: 10, listStatus: "Activa" }))));

  // 2. Every tool through the MCP layer.
  const server = createServer(ctx, memoryAudit());
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "smoke", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);

  const firstPost = vac ? firstArray(await hr.get("/postulants/", { vacancyId: vac.id, page: 0, pageSize: 10 }))[0] : undefined;
  const monthAgo = addDays(today, -30);
  const calls: [string, Record<string, unknown>][] = [
    ["catalogos", { tipo: "pipelines" }],
    ["buscar_vacantes", { estado: ["Activa"] }],
    ["ver_vacante", { id: vac?.id ?? "x", incluir_estadisticas: true }],
    ["buscar_postulantes", { vacante_id: vac?.id, etapa: "Entrevista" }],
    ["ver_postulante", { id: firstPost?.id ?? "x" }],
    ["leer_cv", { postulante_id: firstPost?.id ?? "x" }],
    ["buscar_por_perfil", { palabras: ["soldador"], desde: monthAgo, hasta: today }],
    ["reporte_contrataciones", { desde: addDays(today, -89), hasta: today }],
    ["reporte_movimientos_vacantes", { desde: addDays(today, -13), hasta: today }],
    ["postulaciones_por_dia", { desde: addDays(today, -6), hasta: today }],
  ];
  for (const [name, args] of calls) {
    const t0 = Date.now();
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as { text: string }[])[0]?.text ?? "";
    const json = r.isError ? undefined : JSON.parse(text);
    console.log(
      name.padEnd(30),
      `${Date.now() - t0}ms`.padStart(8),
      r.isError ? `ERROR: ${text}` : `ok bytes=${text.length} keys=${keys(json)} items=${json.items?.length ?? "-"} completo=${json.completo ?? "-"}`,
    );
  }
  await client.close();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
```

Note: error messages printed for `ERROR:` rows are the tool's Spanish messages, which never contain personal data.

- [ ] **Step 2: Move the secrets file and run the smoke**

```bash
mkdir -p ~/.config/hiringroom-mcp
mv ./.env ~/.config/hiringroom-mcp/.env
chmod 600 ~/.config/hiringroom-mcp/.env
npm run smoke
```

Expected: every tool row `ok` (or a clear Spanish error). Then check the shape lines against the code:
- `vacancy.ubicacion` / `client` / `usuarios[0]` keys include the fields `place()`, `label()` and `personName()` read (`ciudad/provincia/pais`, `nombre`, `nombre/apellido`). If not, add the real key names to those helpers and a test case in `test/shape.test.ts`.
- `vacancy detail top-level`: if it is a wrapper (e.g. `["vacante"]`), `ver_vacante` already unwraps `vacante`/`vacancy`; add any other wrapper key to that line.
- `pipeline counts stage[0]` keys: make sure `stageCounts()` reads the real id and count keys; update and add a test if needed.
- `hired top-level list item`: find the hire-date key and make sure `hireDate()` lists it; update the test fixture key in `test/reportes.test.ts` to the real name.
- `estados de vacantes`: use these exact values in the `buscar_vacantes` description example.
- If `reporte_contrataciones` or `reporte_movimientos_vacantes` returns a HiringRoom range error, the windows are one day too long: change `splitWindows(..., 30)` to `29` / `7` to `6` and the expected windows in `test/reportes.test.ts`.

Commit any fixes with their tests:
```bash
git add -A src test
git commit -m "fix: align shapers with real HiringRoom payload keys"
```

- [ ] **Step 3: Write `README.md`**

````markdown
# hiringroom-mcp

Local stdio MCP server that gives Claude Code **read-only** access to Patagonia Resources' HiringRoom account.
Design: `docs/specs/2026-09-23-hiringroom-mcp-design.md`.

## Requirements

- Node 22+
- `pdftotext` (macOS: `brew install poppler`)
- A read-only HiringRoom service user plus the API `client_id` / `client_secret`

## Setup

```bash
npm ci && npm run build
mkdir -p ~/.config/hiringroom-mcp
cp .env.example ~/.config/hiringroom-mcp/.env   # fill it in
chmod 600 ~/.config/hiringroom-mcp/.env
claude mcp add --scope user hiringroom -- node "$(pwd)/dist/index.js"
```

Restart Claude Code and run `/mcp` to check that `hiringroom` is connected.

## Tools

| Tool | Purpose |
|---|---|
| `buscar_vacantes` | Filter vacancies by status, client/area, creation dates, name text |
| `ver_vacante` | Vacancy detail, pipeline counts by stage, notes, questions, optional stats |
| `buscar_postulantes` | Filter applications by vacancy, name, email, stage, status, dates |
| `ver_postulante` | Full profile, records, attachments (`incluir_sensibles` for DNI/birth date) |
| `leer_cv` | Text of a PDF/DOCX CV |
| `buscar_por_perfil` | Scoped keyword cross-search with ranking and match reasons |
| `reporte_contrataciones` | Hires in a range (≤365 days), by vacancy and month |
| `reporte_movimientos_vacantes` | Vacancy status changes (≤90 days) |
| `postulaciones_por_dia` | Applications per day (≤31 days) + top vacancies |
| `catalogos` | Pipelines/stages, clients, areas, reject reasons, sources |

## Operations

- Secrets: `~/.config/hiringroom-mcp/.env` (override with `HIRINGROOM_ENV_FILE`). Must be mode 600.
- Audit log: `~/.local/state/hiringroom-mcp/audit.jsonl` (override with `HR_MCP_AUDIT_DIR`). One line per call; emails and names are hashed.
- Limits: see `src/config.ts` (`HR_MCP_*` env vars).
- `npm test` — unit + tool tests (synthetic data). `npm run smoke` — manual read-only check against the real API; prints counts, timings and key names only.
````

- [ ] **Step 4: Install in Claude Code**

```bash
npm run build
claude mcp add --scope user hiringroom -- node "$(pwd)/dist/index.js"
claude mcp list
```

Expected: `hiringroom` listed as connected.

- [ ] **Step 5: Acceptance (operator runs these in a fresh Claude Code session)**

Record pass/fail for each criterion from spec §10:
1. `/mcp` shows `hiringroom` with 10 tools.
2. "¿Qué vacantes activas hay?" — active vacancies with per-stage counts (spot-check one against the HiringRoom UI).
3. "Postulantes en Entrevista de la vacante X" — stage resolved by name; count matches the UI.
4. "Contrataciones de los últimos 90 días" — total matches the UI; audit shows one `reporte_contrataciones` line.
5. "Buscá soldadores con experiencia en Neuquén entre los postulantes de agosto" — ranking with `coincidencias` and `escaneados/total_en_alcance`.
6. "Leé el CV de <postulante>" — text returned; `truncado: true` for long CVs.
7. No response shows DNI or birth date unless asked ("incluí datos sensibles").
8. `tail ~/.local/state/hiringroom-mcp/audit.jsonl` — one line per call, no plain names/emails.
9. Temporarily set a wrong `HR_PASSWORD`, restart, ask anything — clear "credenciales de HiringRoom inválidas" error, server stays up. Restore the password.

- [ ] **Step 6: Commit**

```bash
git add scripts/smoke.ts README.md
git commit -m "docs: add smoke script and README with install and operations"
```

---

## Spec coverage check

| Spec section | Task |
|---|---|
| §3.1 config/secrets, pdftotext check | 1, 7, 9 (`index.ts`) |
| §3.2 HR client (GET-only, re-login, retries, 429, concurrency, typed errors) | 3 |
| §3.3 dates, windows | 2 |
| §4.1 conventions (ISO, limite/pagina, omit nulls, completo/advertencias, trim) | 5, 9, 10–14 |
| §4.2 summaries, sensitive fields | 5 |
| §4.3 tools 1–10 | 9 (catalogos), 10, 11, 12, 13, 14 |
| §5 scoring | 6, 13 |
| §6.1 errors, partial results | 3, 9, 10–14 |
| §6.2 limits | 1 (+ usage in 9–14) |
| §7 security (redaction, GET-only, CV in memory/temp deleted, synthetic fixtures, stderr) | 3, 5, 7, 8 |
| §8 audit | 8, 9 |
| §9 repo/stack/tests/smoke | 1, 15 |
| §10 acceptance | 15 |
| §11 open items | 15 step 2 (move secrets); others are operator items outside code |
