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
