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
