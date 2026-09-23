import { buscarPorPerfil } from "./buscar-por-perfil.js";
import { buscarPostulantes } from "./buscar-postulantes.js";
import { buscarVacantes } from "./buscar-vacantes.js";
import { catalogos } from "./catalogos.js";
import type { ToolDef } from "./define.js";
import { leerCv } from "./leer-cv.js";
import { verPostulante } from "./ver-postulante.js";
import { verVacante } from "./ver-vacante.js";

export const ALL_TOOLS: ToolDef<any>[] = [
  buscarVacantes,
  verVacante,
  buscarPostulantes,
  verPostulante,
  leerCv,
  buscarPorPerfil,
  catalogos,
];
