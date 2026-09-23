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
