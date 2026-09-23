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
