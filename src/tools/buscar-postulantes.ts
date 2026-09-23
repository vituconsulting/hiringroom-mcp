import { z } from "zod";
import { getPipelines, resolveStage } from "../hr/catalog.js";
import { assertRange, epochEnd, epochStart } from "../hr/dates.js";
import { firstArray } from "../hr/paginate.js";
import { postulantSummary } from "../shape/postulant.js";
import type { ToolContext } from "./context.js";
import { defineTool, isoDate, limite, pagina } from "./define.js";

export async function stageQuery(etapa: string | undefined, ctx: ToolContext): Promise<number | undefined> {
  if (!etapa) return undefined;
  return resolveStage(await getPipelines(ctx.hr, ctx.cache), etapa);
}

export const buscarPostulantes = defineTool({
  name: "buscar_postulantes",
  description:
    "Busca postulaciones por vacante, nombre, apellido, email, etapa del pipeline (nombre como \"Entrevista\" o id), estado y rango de fecha de postulación (YYYY-MM-DD). Devuelve un resumen por postulante (último puesto, años de experiencia, estudio, ubicación). Para buscar por perfil/experiencia usá buscar_por_perfil.",
  input: {
    vacante_id: z.string().optional(),
    nombre: z.string().optional(),
    apellido: z.string().optional(),
    email: z.string().optional(),
    etapa: z.string().optional().describe("nombre de etapa (ej. Entrevista) o id numérico"),
    estado: z.string().optional(),
    desde: isoDate.optional().describe("fecha de postulación desde"),
    hasta: isoDate.optional().describe("fecha de postulación hasta"),
    limite,
    pagina,
  },
  async run(a, ctx) {
    if (a.desde && a.hasta) assertRange(a.desde, a.hasta);
    const body = await ctx.hr.get("/postulants/", {
      vacancyId: a.vacante_id,
      nombre: a.nombre,
      apellido: a.apellido,
      email: a.email,
      stage: await stageQuery(a.etapa, ctx),
      status: a.estado,
      createdFrom: a.desde ? epochStart(a.desde) : undefined,
      createdTo: a.hasta ? epochEnd(a.hasta) : undefined,
      page: a.pagina - 1,
      pageSize: a.limite,
    });
    const now = ctx.now();
    const items = firstArray(body).map((r) => postulantSummary(r, now));
    const totalPaginas = typeof body?.totalPaginas === "number" ? body.totalPaginas : 1;
    return { total: body?.total ?? items.length, pagina: a.pagina, hay_mas: a.pagina < totalPaginas, items };
  },
});
