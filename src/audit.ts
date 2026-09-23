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
