import { assertRange, eachDay, toDmy } from "../hr/dates.js";
import { fetchAll } from "../hr/paginate.js";
import { label } from "../shape/common.js";
import { defineTool, errorMessage, isoDate } from "./define.js";

const DAY_MAX_ITEMS = 1000;

export const postulacionesPorDia = defineTool({
  name: "postulaciones_por_dia",
  description:
    "Cantidad de postulaciones por día en un rango (YYYY-MM-DD, máximo 31 días) y las 10 vacantes con más postulaciones en ese período. No devuelve datos de postulantes.",
  input: { desde: isoDate, hasta: isoDate },
  async run({ desde, hasta }, ctx) {
    assertRange(desde, hasta, 31);
    const days = eachDay(desde, hasta);
    const results = await Promise.allSettled(days.map((d) => fetchAll(ctx.hr, "/postulants/byDay/", { day: toDmy(d) }, DAY_MAX_ITEMS)));
    const advertencias: string[] = [];
    let completo = true;
    const porVacante = new Map<string, { vacante_id: string; vacante: string; cantidad: number }>();
    const por_dia = results.map((r, i) => {
      if (r.status === "rejected") {
        completo = false;
        advertencias.push(`${days[i]} falló: ${errorMessage(r.reason)}`);
        return { fecha: days[i], cantidad: undefined };
      }
      if (!r.value.completo) {
        completo = false;
        advertencias.push(`${days[i]}: top de vacantes calculado sobre ${r.value.items.length} de ${r.value.total}`);
      }
      for (const raw of r.value.items) {
        const id = label(raw?.vacanteId) ?? "sin vacante";
        const entry = porVacante.get(id) ?? { vacante_id: id, vacante: label(raw?.vacanteNombre) ?? id, cantidad: 0 };
        entry.cantidad++;
        porVacante.set(id, entry);
      }
      return { fecha: days[i], cantidad: r.value.total };
    });
    return {
      total: por_dia.reduce((s, d) => s + (d.cantidad ?? 0), 0),
      completo,
      advertencias,
      por_dia,
      top_vacantes: [...porVacante.values()].sort((a, b) => b.cantidad - a.cantidad).slice(0, 10),
    };
  },
});
