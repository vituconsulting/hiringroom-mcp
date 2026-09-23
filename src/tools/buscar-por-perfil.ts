import { z } from "zod";
import { AuthError, InputError } from "../errors.js";
import { assertRange, epochEnd, epochStart } from "../hr/dates.js";
import { fetchAll } from "../hr/paginate.js";
import { rank } from "../search/perfil.js";
import { postulantSummary } from "../shape/postulant.js";
import { stageQuery } from "./buscar-postulantes.js";
import { defineTool, isoDate } from "./define.js";
import { fetchCvText } from "./leer-cv.js";

export const buscarPorPerfil = defineTool({
  name: "buscar_por_perfil",
  description:
    "Búsqueda cruzada de candidatos por perfil (ej. soldadores con experiencia en Neuquén). Requiere acotar por vacante_id o por rango de fecha de postulación (desde + hasta). Busca las palabras (sin importar tildes/mayúsculas, por prefijo; admite frases) en puestos, áreas, descripciones, estudios, tags, presentación y ubicación; opcionalmente también en el texto de los CVs de los mejores resultados. Devuelve un ranking con el motivo de cada coincidencia y cuántos postulantes se escanearon.",
  input: {
    palabras: z.array(z.string().min(2)).min(1).max(20),
    excluir: z.array(z.string().min(2)).max(20).optional(),
    vacante_id: z.string().optional(),
    desde: isoDate.optional(),
    hasta: isoDate.optional(),
    etapa: z.string().optional(),
    max_escanear: z.number().int().min(10).max(1000).optional().describe("por defecto 1000"),
    incluir_cv: z.boolean().default(false).describe("lee los CV del top 30 (más lento)"),
    limite: z.number().int().min(1).max(50).default(20),
  },
  async run(a, ctx) {
    if (!a.vacante_id && !(a.desde && a.hasta)) {
      throw new InputError("acotá por vacante o fechas: pasá vacante_id, o desde + hasta");
    }
    if (a.desde && a.hasta) assertRange(a.desde, a.hasta);
    const deadline = Date.now() + ctx.limits.perfilBudgetMs;
    const maxScan = Math.min(a.max_escanear ?? ctx.limits.perfilMaxScan, ctx.limits.perfilMaxScan);

    const scan = await fetchAll(
      ctx.hr,
      "/postulants/",
      {
        vacancyId: a.vacante_id,
        stage: await stageQuery(a.etapa, ctx),
        createdFrom: a.desde ? epochStart(a.desde) : undefined,
        createdTo: a.hasta ? epochEnd(a.hasta) : undefined,
      },
      maxScan,
      { deadline },
    );
    const advertencias = [...scan.advertencias];
    let completo = scan.completo;
    let ranked = rank(scan.items, a.palabras, a.excluir);

    if (a.incluir_cv && ranked.length) {
      const top = ranked.slice(0, ctx.limits.perfilCvTop);
      const cvById = new Map<string, string>();
      let fallidos = 0;
      let omitidos = 0;
      await Promise.all(
        top.map(async (r) => {
          if (Date.now() > deadline) {
            omitidos++;
            return;
          }
          try {
            cvById.set(String(r.raw.id), (await fetchCvText(ctx, String(r.raw.id))).text);
          } catch (err) {
            if (err instanceof AuthError) throw err;
            fallidos++;
          }
        }),
      );
      if (fallidos) advertencias.push(`${fallidos} CV no se pudieron leer (sin adjunto legible o error)`);
      if (omitidos) {
        completo = false;
        advertencias.push(`${omitidos} CV omitidos por presupuesto de tiempo`);
      }
      ranked = rank(scan.items, a.palabras, a.excluir, cvById);
    }

    const now = ctx.now();
    return {
      escaneados: scan.items.length,
      total_en_alcance: scan.total,
      total_coincidencias: ranked.length,
      completo,
      advertencias,
      items: ranked.slice(0, a.limite).map((r) => ({
        ...postulantSummary(r.raw, now),
        score: r.score,
        coincidencias: r.coincidencias,
        vacantes: r.vacantes,
      })),
    };
  },
});
