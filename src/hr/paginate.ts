import type { HrLike, Query } from "./client.js";

export const PAGE_SIZE = 100;

export interface PageResult {
  items: any[];
  total: number;
  completo: boolean;
  advertencias: string[];
}

/** HiringRoom wraps lists under different keys (vacantes, curriculums, archivos...). */
export function firstArray(body: unknown): any[] {
  if (Array.isArray(body)) return body;
  if (body && typeof body === "object") {
    for (const v of Object.values(body)) if (Array.isArray(v)) return v;
  }
  return [];
}

export async function fetchAll(
  hr: HrLike,
  path: string,
  query: Query,
  maxItems: number,
  opts: { deadline?: number; now?: () => number; batch?: number } = {},
): Promise<PageResult> {
  const now = opts.now ?? Date.now;
  const batch = opts.batch ?? 5;
  const first = await hr.get(path, { ...query, page: 0, pageSize: PAGE_SIZE });
  const items = [...firstArray(first)];
  const total = typeof first?.total === "number" ? first.total : items.length;
  const pages = typeof first?.totalPaginas === "number" ? first.totalPaginas : 1;
  const lastPage = Math.min(pages, Math.ceil(Math.min(total, maxItems) / PAGE_SIZE)) - 1;
  const advertencias: string[] = [];
  let completo = true;

  const remaining = Array.from({ length: Math.max(0, lastPage) }, (_, i) => i + 1);
  for (let i = 0; i < remaining.length; i += batch) {
    if (opts.deadline !== undefined && now() > opts.deadline) {
      completo = false;
      advertencias.push("presupuesto de tiempo agotado: resultados parciales");
      break;
    }
    const chunk = remaining.slice(i, i + batch);
    const results = await Promise.allSettled(chunk.map((page) => hr.get(path, { ...query, page, pageSize: PAGE_SIZE })));
    results.forEach((r, j) => {
      if (r.status === "fulfilled") items.push(...firstArray(r.value));
      else {
        completo = false;
        advertencias.push(`página ${chunk[j] + 1} falló: ${(r.reason as Error).message}`);
      }
    });
  }

  if (total > maxItems) {
    completo = false;
    advertencias.push(`se escanearon ${Math.min(items.length, maxItems)} de ${total}; acotá la búsqueda para cubrir todo`);
  }
  return { items: items.slice(0, maxItems), total, completo, advertencias };
}
