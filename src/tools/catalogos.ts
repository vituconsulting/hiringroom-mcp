import { z } from "zod";
import { getPipelines } from "../hr/catalog.js";
import { firstArray } from "../hr/paginate.js";
import { defineTool } from "./define.js";

const SOURCES = {
  clientes: "/account/customers",
  areas: "/account/areas",
  motivos_rechazo: "/common/rejectReasons",
  fuentes: "/common/sources",
} as const;

export const catalogos = defineTool({
  name: "catalogos",
  description:
    "Listas de referencia de la cuenta HiringRoom: pipelines (con sus etapas e ids), clientes, áreas, motivos de rechazo y fuentes de postulantes. Usalo para conocer ids y nombres válidos antes de filtrar.",
  input: { tipo: z.enum(["pipelines", "clientes", "areas", "motivos_rechazo", "fuentes"]) },
  async run({ tipo }, ctx) {
    if (tipo === "pipelines") {
      const items = await getPipelines(ctx.hr, ctx.cache);
      return { tipo, total: items.length, items };
    }
    const path = SOURCES[tipo];
    const raw = await ctx.cache.get(`catalogo:${tipo}`, () => ctx.hr.get(path));
    const hasList = Array.isArray(raw) || (!!raw && typeof raw === "object" && Object.values(raw).some(Array.isArray));
    const items = hasList ? firstArray(raw) : raw && typeof raw === "object" ? [raw] : [];
    return { tipo, total: items.length, items };
  },
});
