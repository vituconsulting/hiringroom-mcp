import { normalizeHrDate } from "../hr/dates.js";
import { arr, compact, label, num, place, siNo } from "./common.js";

export interface PostulantSummary {
  id: string;
  nombre_completo: string;
  email?: string;
  vacante?: { id?: string; nombre?: string };
  etapa?: string;
  rechazado?: boolean;
  fecha_postulacion?: string;
  ubicacion?: string;
  ultimo_puesto?: { puesto?: string; empresa?: string; desde?: string; hasta?: string };
  anios_experiencia?: number;
  nivel_estudio?: string;
  tags?: string[];
}

const NEVER = ["genero", "fotoPerfil"];
const SENSITIVE = ["dni", "cuil", "fechaNacimiento"];

function monthIndex(year: unknown, month: unknown): number | undefined {
  const y = num(year);
  if (!y) return undefined;
  const m = num(month) ?? 1;
  return y * 12 + (Math.min(Math.max(m, 1), 12) - 1);
}

function interval(e: any, now: Date): [number, number] | undefined {
  const start = monthIndex(e?.añoDesde, e?.mesDesde);
  if (start === undefined) return undefined;
  const end = e?.trabajoActual || e?.estudioActual
    ? now.getFullYear() * 12 + now.getMonth() + 1
    : (monthIndex(e?.añoHasta, e?.mesHasta) ?? start) + 1;
  return end > start ? [start, end] : undefined;
}

export function aniosExperiencia(exps: unknown, now: Date): number | undefined {
  const spans = arr(exps)
    .map((e) => interval(e, now))
    .filter((x): x is [number, number] => !!x)
    .sort((a, b) => a[0] - b[0]);
  if (!spans.length) return undefined;
  let months = 0;
  let [cs, ce] = spans[0];
  for (const [s, e] of spans.slice(1)) {
    if (s <= ce) ce = Math.max(ce, e);
    else {
      months += ce - cs;
      [cs, ce] = [s, e];
    }
  }
  months += ce - cs;
  return Math.round((months / 12) * 10) / 10;
}

function ym(year: unknown, month: unknown): string | undefined {
  const y = num(year);
  if (!y) return undefined;
  const m = num(month);
  return m ? `${y}-${String(m).padStart(2, "0")}` : String(y);
}

function ultimoPuesto(exps: unknown, now: Date) {
  const list = arr(exps);
  if (!list.length) return undefined;
  const endOf = (e: any) => (e?.trabajoActual ? Infinity : (interval(e, now)?.[1] ?? 0));
  const e = list.reduce((a, b) => (endOf(b) > endOf(a) ? b : a));
  return {
    puesto: label(e.puesto),
    empresa: label(e.empresa),
    desde: ym(e.añoDesde, e.mesDesde),
    hasta: e.trabajoActual ? "actual" : ym(e.añoHasta, e.mesHasta),
  };
}

function nivelEstudio(estudios: unknown): string | undefined {
  const list = arr(estudios);
  if (!list.length) return undefined;
  const endOf = (e: any) => (e?.estudioActual ? Infinity : (num(e?.añoHasta) ?? 0));
  const e = list.reduce((a, b) => (endOf(b) > endOf(a) ? b : a));
  const nivel = label(e.nivel);
  const estado = label(e.estado);
  return nivel && estado ? `${nivel} (${estado})` : nivel;
}

function fullName(raw: any): string {
  return [label(raw.nombre), label(raw.apellido)].filter(Boolean).join(" ");
}

export function postulantSummary(raw: any, now: Date): PostulantSummary {
  return compact({
    id: String(raw.id),
    nombre_completo: fullName(raw),
    email: label(raw.email),
    vacante: { id: label(raw.vacanteId), nombre: label(raw.vacanteNombre) },
    etapa: label(raw.etapa),
    rechazado: siNo(raw.rechazado),
    fecha_postulacion: normalizeHrDate(raw.fechaPostulacion),
    ubicacion: place(raw.direccion),
    ultimo_puesto: ultimoPuesto(raw.experienciasLaborales, now),
    anios_experiencia: aniosExperiencia(raw.experienciasLaborales, now),
    nivel_estudio: nivelEstudio(raw.estudios),
    tags: arr(raw.tags).map(label).filter((x): x is string => !!x),
  });
}

export function postulantProfile(raw: any, now: Date, incluirSensibles: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw };
  for (const k of NEVER) delete out[k];
  if (!incluirSensibles) for (const k of SENSITIVE) delete out[k];
  return compact({
    nombre_completo: fullName(raw),
    anios_experiencia: aniosExperiencia(raw.experienciasLaborales, now),
    ...out,
  });
}
