import { assertRange, splitWindows, toDmy } from "../hr/dates.js";
import { vacancySummary } from "../shape/vacancy.js";
import { defineTool, isoDate } from "./define.js";
import { countBy, fetchWindows } from "./reporte-contrataciones.js";

export const reporteMovimientosVacantes = defineTool({
  name: "reporte_movimientos_vacantes",
  description:
    "Vacantes que cambiaron de estado en un rango de fechas (YYYY-MM-DD, máximo 90 días). Devuelve conteos por estado actual y la lista de vacantes (resumen).",
  input: { desde: isoDate, hasta: isoDate },
  async run({ desde, hasta }, ctx) {
    assertRange(desde, hasta, 90);
    const res = await fetchWindows(ctx, "/vacancies/byChangedStatus", splitWindows(desde, hasta, 7), (w) => ({
      start: toDmy(w.desde),
      end: toDmy(w.hasta),
    }));
    const items = res.items.map(vacancySummary);
    return {
      total: items.length,
      completo: res.completo,
      advertencias: res.advertencias,
      por_estado: countBy(items, (v) => v.estado ?? "sin estado").map(({ clave, cantidad }) => ({ estado: clave, cantidad })),
      items,
    };
  },
});
