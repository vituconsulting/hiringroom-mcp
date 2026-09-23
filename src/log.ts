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
