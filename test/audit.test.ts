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
