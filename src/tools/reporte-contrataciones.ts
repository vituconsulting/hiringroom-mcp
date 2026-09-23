import { assertRange, normalizeHrDate, splitWindows, toDmy, type DateWindow } from "../hr/dates.js";
import type { Query } from "../hr/client.js";
import { fetchAll } from "../hr/paginate.js";
import { label } from "../shape/common.js";
import { postulantSummary } from "../shape/postulant.js";
import type { ToolContext } from "./context.js";
import { defineTool, errorMessage, isoDate } from "./define.js";

const WINDOW_MAX_ITEMS = 10_000;

export async function fetchWindows(
  ctx: ToolContext,
  path: string,
  windows: DateWindow[],
  toQuery: (w: DateWindow) => Query,
): Promise<{ items: any[]; completo: boolean; advertencias: string[] }> {
  const results = await Promise.allSettled(windows.map((w) => fetchAll(ctx.hr, path, toQuery(w), WINDOW_MAX_ITEMS)));
  const items: any[] = [];
  const advertencias: string[] = [];
  let completo = true;
  results.forEach((r, i) => {
    const w = windows[i];
    if (r.status === "rejected") {
      completo = false;
      advertencias.push(`ventana ${toDmy(w.desde)}..${toDmy(w.hasta)} falló: ${errorMessage(r.reason)}`);
      return;
    }
    items.push(...r.value.items);
    if (!r.value.completo) {
      completo = false;
      advertencias.push(...r.value.advertencias.map((a) => `ventana ${toDmy(w.desde)}..${toDmy(w.hasta)}: ${a}`));
    }
  });
  return { items, completo, advertencias };
}

export function countBy<T>(items: T[], key: (x: T) => string): { clave: string; cantidad: number }[] {
  const m = new Map<string, number>();
  for (const x of items) m.set(key(x), (m.get(key(x)) ?? 0) + 1);
  return [...m.entries()].map(([clave, cantidad]) => ({ clave, cantidad })).sort((a, b) => b.cantidad - a.cantidad);
}

/**
 * `fechaIngreso` is the real hire-date key on `/postulants/hired/` items (probe 2026-09-23):
 * across three consecutive HiringRoom-filtered windows, 27/27 items fell inside the requested
 * `start`/`end` range on `fechaIngreso` vs 25/27 on the sibling field `fechaAccionIngreso`
 * (the date the "hired" status change was recorded), confirming `fechaIngreso` is what the API
 * filters on.
 */
function hireDate(raw: any): string | undefined {
  return normalizeHrDate(raw?.fechaIngreso);
}

export const reporteContrataciones = defineTool({
  name: "reporte_contrataciones",
  description:
    "Contrataciones en un rango de fechas (YYYY-MM-DD, máximo 365 días). Devuelve el total, conteos por vacante y por mes, y la lista de contratados (resumen).",
  input: { desde: isoDate, hasta: isoDate },
  async run({ desde, hasta }, ctx) {
    assertRange(desde, hasta, 365);
    const windows = splitWindows(desde, hasta, 30);
    const res = await fetchWindows(ctx, "/postulants/hired/", windows, (w) => ({ start: toDmy(w.desde), end: toDmy(w.hasta) }));
    const now = ctx.now();
    const items = res.items.map((raw) => ({ ...postulantSummary(raw, now), fecha_contratacion: hireDate(raw) }));
    return {
      total: items.length,
      completo: res.completo,
      advertencias: res.advertencias,
      por_vacante: countBy(res.items, (r) => label(r?.vacanteNombre) ?? "sin vacante").map(({ clave, cantidad }) => ({ vacante: clave, cantidad })),
      por_mes: countBy(items, (i) => i.fecha_contratacion?.slice(0, 7) ?? "sin fecha")
        .map(({ clave, cantidad }) => ({ mes: clave, cantidad }))
        .sort((a, b) => a.mes.localeCompare(b.mes)),
      items,
    };
  },
});
