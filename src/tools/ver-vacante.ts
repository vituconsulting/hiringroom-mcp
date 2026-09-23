import { z } from "zod";
import { AuthError, UpstreamError } from "../errors.js";
import { getPipelines, stageName, type Pipeline } from "../hr/catalog.js";
import { firstArray } from "../hr/paginate.js";
import { arr, num } from "../shape/common.js";
import { vacancyDetail } from "../shape/vacancy.js";
import { defineTool, enc, errorMessage, orNotFound, settle, unwrap } from "./define.js";

function stageCounts(counts: any, pipelines: Pipeline[], pipelineId?: string) {
  const etapas = arr(counts?.pipeline?.stage).map((s: any) => {
    const id = num(s?.id ?? s?.stage ?? s?.etapa ?? s?.idEtapa);
    const cantidad = num(s?.total ?? s?.count ?? s?.cantidad ?? s?.cantidadPostulantes) ?? 0;
    return { etapa: (id !== undefined && stageName(pipelines, id, pipelineId)) || `etapa ${id ?? "?"}`, cantidad };
  });
  return { total: num(counts?.pipeline?.total) ?? num(counts?.total), rechazados: num(counts?.rejecteds?.total), etapas };
}

export const verVacante = defineTool({
  name: "ver_vacante",
  description:
    "Detalle de una vacante: descripción, requisitos, responsables, cantidad de postulantes por etapa del pipeline (con nombres), notas y preguntas. Las estadísticas son opcionales porque HiringRoom tarda en calcularlas.",
  input: {
    id: z.string().min(1),
    incluir_estadisticas: z.boolean().default(false),
  },
  async run({ id, incluir_estadisticas }, ctx) {
    const base = `/vacancies/${enc(id)}`;
    const body = await orNotFound(ctx.hr.get(base), "vacante", id);
    const raw = unwrap(body, "vacante", "vacancy");
    const [pipelines, counts, notas, preguntas, requisitos] = await Promise.all([
      settle(getPipelines(ctx.hr, ctx.cache)),
      settle(ctx.hr.get(`${base}/pipeline/counts`)),
      settle(ctx.hr.get(`${base}/notes`)),
      settle(ctx.hr.get(`${base}/questions`)),
      settle(ctx.hr.get(`${base}/requirements`)),
    ]);
    const advertencias: string[] = [];
    const pick = (name: string, r: { ok: true; value: any } | { ok: false; error: string }) => {
      if (r.ok) return r.value?.result ?? firstArray(r.value);
      advertencias.push(`${name}: ${r.error}`);
      return undefined;
    };

    let estadisticas: unknown;
    if (incluir_estadisticas) {
      try {
        estadisticas = await ctx.hr.get(`${base}/stats`, {}, { timeoutMs: ctx.limits.statsBudgetMs, retries: 0 });
      } catch (err) {
        if (err instanceof AuthError) throw err;
        if (err instanceof UpstreamError) {
          estadisticas = "no disponible (timeout)";
        } else {
          estadisticas = "no disponible";
          advertencias.push(`estadisticas: ${errorMessage(err)}`);
        }
      }
    }

    if (!counts.ok) advertencias.push(`pipeline: ${counts.error}`);
    if (!pipelines.ok) advertencias.push(`catalogo de etapas: ${pipelines.error}`);
    return {
      vacante: vacancyDetail(raw),
      pipeline: counts.ok ? stageCounts(counts.value, pipelines.ok ? pipelines.value : [], raw?.pipelineId) : undefined,
      notas: pick("notas", notas),
      preguntas: pick("preguntas", preguntas),
      requisitos_detalle: pick("requisitos", requisitos),
      estadisticas,
      advertencias,
    };
  },
});
