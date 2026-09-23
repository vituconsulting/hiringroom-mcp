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
