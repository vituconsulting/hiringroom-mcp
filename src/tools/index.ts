import { buscarVacantes } from "./buscar-vacantes.js";
import { catalogos } from "./catalogos.js";
import type { ToolDef } from "./define.js";
import { verVacante } from "./ver-vacante.js";

export const ALL_TOOLS: ToolDef<any>[] = [buscarVacantes, verVacante, catalogos];
