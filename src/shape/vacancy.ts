import { normalizeHrDate } from "../hr/dates.js";
import { arr, compact, label, num, personName, place, siNo } from "./common.js";

export interface VacancySummary {
  id: string;
  nombre: string;
  estado?: string;
  cliente?: string;
  area?: string;
  ubicacion?: string;
  fecha_creacion?: string;
  fecha_cierre?: string;
  posiciones?: number;
  prioridad?: string;
  responsables?: string[];
}

export function vacancySummary(raw: any): VacancySummary {
  return compact({
    id: String(raw.id),
    nombre: label(raw.nombre) ?? "",
    estado: label(raw.estadoActual),
    cliente: label(raw.client),
    area: label(raw.areaTrabajo),
    ubicacion: place(raw.ubicacion),
    fecha_creacion: normalizeHrDate(raw.fechaCreacion),
    fecha_cierre: normalizeHrDate(raw.fechaCierre),
    posiciones: num(raw.posicionesACubrir),
    prioridad: label(raw.prioridad),
    responsables: arr(raw.usuarios).map(personName).filter((x): x is string => !!x),
  });
}

export function vacancyDetail(raw: any): Record<string, unknown> {
  return compact({
    ...vacancySummary(raw),
    subarea: label(raw.subareaTrabajo),
    tipo_trabajo: label(raw.tipoTrabajo),
    modalidad: label(raw.modalidadTrabajo),
    jerarquia: label(raw.jerarquia),
    nivel_minimo_educacion: label(raw.nivelMinimoEducacion),
    remuneracion: num(raw.remuneracion) || undefined,
    moneda: label(raw.currency),
    publicada: siNo(raw.publicada),
    deadline: normalizeHrDate(raw.deadline),
    creada_por: personName(raw.creadaPor),
    pipeline_id: label(raw.pipelineId),
    descripcion: label(raw.descripcionTrabajo),
    requisitos: label(raw.requisitos),
  });
}
