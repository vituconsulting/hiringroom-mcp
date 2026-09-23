export function compact<T>(v: T): T {
  if (Array.isArray(v)) {
    return v.map(compact).filter((x) => !isEmpty(x)) as T;
  }
  if (v && typeof v === "object" && !(v instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      const c = compact(x);
      if (!isEmpty(c)) out[k] = c;
    }
    return out as T;
  }
  return v;
}

function isEmpty(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v).length === 0;
  return false;
}

export function label(v: unknown): string | undefined {
  if (typeof v === "string") return v.trim() || undefined;
  if (typeof v === "number") return String(v);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    // `compañia` is the real HiringRoom key for a client's name (probe 2026-09-23); it must
    // outrank `descripcion`, which on a client object is free text, not an identifying label.
    return label(o.nombre ?? o.name ?? o.compañia ?? o.descripcion ?? o.razonSocial);
  }
  return undefined;
}

export function personName(v: unknown): string | undefined {
  if (typeof v === "string") return v.trim() || undefined;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const full = [label(o.nombre), label(o.apellido)].filter(Boolean).join(" ");
    return full || label(o.email);
  }
  return undefined;
}

export function place(v: unknown): string | undefined {
  if (typeof v === "string") return v.trim() || undefined;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return [label(o.ciudad), label(o.provincia), label(o.pais)].filter(Boolean).join(", ") || undefined;
  }
  return undefined;
}

export function siNo(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  if (typeof v !== "string") return undefined;
  const s = v.trim().toLowerCase();
  if (["si", "sí", "yes", "true", "1"].includes(s)) return true;
  if (["no", "false", "0"].includes(s)) return false;
  return undefined;
}

export function num(v: unknown): number | undefined {
  const n = typeof v === "string" && v.trim() ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

export function arr(v: unknown): any[] {
  return Array.isArray(v) ? v : [];
}

export function jsonBytes(v: unknown): number {
  return Buffer.byteLength(JSON.stringify(v));
}

/** Shortens the longest top-level array until the JSON fits in maxBytes. */
export function trimToSize<T extends Record<string, unknown>>(value: T, maxBytes: number): T & { recortado?: true } {
  if (jsonBytes(value) <= maxBytes) return value;
  const out: Record<string, unknown> = { ...value };
  for (const [k, v] of Object.entries(out)) if (Array.isArray(v)) out[k] = [...v];
  out.recortado = true;
  while (jsonBytes(out) > maxBytes) {
    const lists = Object.values(out).filter((v): v is unknown[] => Array.isArray(v) && v.length > 0);
    if (!lists.length) break;
    const longest = lists.reduce((a, b) => (b.length > a.length ? b : a));
    longest.pop();
  }
  return out as T & { recortado: true };
}
