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

/** These represent counts/byte sizes, not time budgets, and must be whole numbers. */
const INTEGER_LIMITS = new Set<keyof Limits>([
  "concurrency",
  "perfilMaxScan",
  "perfilCvTop",
  "cvMaxBytes",
  "cvDefaultChars",
  "cvMaxChars",
  "responseMaxBytes",
]);

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

export function loadConfig(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Config {
  const file = defaultEnvFile(env);
  let mode: number;
  try {
    mode = statSync(file).mode;
  } catch {
    throw new ConfigError(`no se encontró el archivo de secretos: ${file}`);
  }
  // Windows has no POSIX modes (stat reports 0o666/0o444); the user profile's NTFS ACLs protect the file there.
  if (platform !== "win32" && (mode & 0o077) !== 0) {
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
    if (INTEGER_LIMITS.has(key) && !Number.isInteger(n)) throw new ConfigError(`${LIMIT_ENV[key]} debe ser un número entero`);
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
