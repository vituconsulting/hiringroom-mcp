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
