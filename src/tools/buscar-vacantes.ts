import { z } from "zod";
import { assertRange, epochEnd, epochStart } from "../hr/dates.js";
import { fetchAll, firstArray } from "../hr/paginate.js";
import { vacancySummary } from "../shape/vacancy.js";
import { normalize } from "../text.js";
import { defineTool, isoDate, limite, pagina } from "./define.js";

const TEXT_SCAN_MAX = 1000;

export const buscarVacantes = defineTool({
  name: "buscar_vacantes",
  description:
    "Busca vacantes (búsquedas laborales) de la cuenta. Filtros: estado (ej. Activa, Cerrada), cliente o área, rango de fecha de creación (YYYY-MM-DD) y texto en el nombre. Devuelve un resumen por vacante; usá ver_vacante para el detalle y los contadores del pipeline.",
  input: {
    estado: z.array(z.string()).optional().describe("estados, ej. [\"Activa\"]"),
    cliente_o_area_id: z.string().optional(),
    creada_desde: isoDate.optional(),
    creada_hasta: isoDate.optional(),
    texto: z.string().min(2).optional().describe("texto a buscar en el nombre de la vacante"),
    limite,
    pagina,
  },
  async run(a, ctx) {
    if (a.creada_desde && a.creada_hasta) assertRange(a.creada_desde, a.creada_hasta);
    const query = {
      listStatus: a.estado?.join(","),
      areaOrCustomerId: a.cliente_o_area_id,
      createdFrom: a.creada_desde ? epochStart(a.creada_desde) : undefined,
      createdTo: a.creada_hasta ? epochEnd(a.creada_hasta) : undefined,
    };

    if (!a.texto) {
      const body = await ctx.hr.get("/vacancies", { ...query, page: a.pagina - 1, pageSize: a.limite });
      const items = firstArray(body).map(vacancySummary);
      const totalPaginas = typeof body?.totalPaginas === "number" ? body.totalPaginas : 1;
      return { total: body?.total ?? items.length, pagina: a.pagina, hay_mas: a.pagina < totalPaginas, items };
    }

    const scan = await fetchAll(ctx.hr, "/vacancies", query, TEXT_SCAN_MAX);
    const q = normalize(a.texto);
    const matched = scan.items.filter((v) => normalize(String(v?.nombre ?? "")).includes(q)).map(vacancySummary);
    const start = (a.pagina - 1) * a.limite;
    return {
      total: matched.length,
      pagina: a.pagina,
      hay_mas: start + a.limite < matched.length,
      completo: scan.completo,
      advertencias: scan.advertencias,
      items: matched.slice(start, start + a.limite),
    };
  },
});
