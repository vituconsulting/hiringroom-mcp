import { normalizeHrDate } from "../hr/dates.js";
import { arr, label, place } from "../shape/common.js";
import { normalize } from "../text.js";

export const WEIGHTS = {
  puesto: 3,
  titulo_estudio: 2,
  area: 2,
  tag: 2,
  descripcion: 1,
  presentacion: 1,
  ubicacion: 1,
  cv: 1,
} as const;

export type Campo = keyof typeof WEIGHTS;

export interface Match {
  palabra: string;
  campo: Campo;
}

export interface Scored {
  score: number;
  coincidencias: Match[];
}

export interface Ranked extends Scored {
  raw: any;
  vacantes: { id?: string; nombre?: string }[];
}

function tokens(s: string): string[] {
  return normalize(s).split(/[^a-z0-9]+/).filter(Boolean);
}

function fieldsOf(raw: any, cvText?: string): Array<[Campo, string[]]> {
  const f: Array<[Campo, string | undefined]> = [];
  for (const e of arr(raw.experienciasLaborales)) {
    f.push(["puesto", label(e?.puesto)], ["area", label(e?.area)], ["area", label(e?.subArea)], ["descripcion", label(e?.descripcion)]);
  }
  for (const e of arr(raw.estudios)) f.push(["titulo_estudio", label(e?.titulo)]);
  for (const t of arr(raw.tags)) f.push(["tag", label(t)]);
  f.push(["presentacion", label(raw.presentacionPostulante)], ["ubicacion", place(raw.direccion)], ["cv", cvText]);
  return f.filter((x): x is [Campo, string] => !!x[1]).map(([c, t]) => [c, tokens(t)]);
}

/** Every query token must prefix-match consecutive field tokens. */
function contains(field: string[], query: string[]): boolean {
  if (!query.length) return false;
  for (let i = 0; i + query.length <= field.length; i++) {
    if (query.every((q, j) => field[i + j].startsWith(q))) return true;
  }
  return false;
}

export function scoreCandidate(raw: any, palabras: string[], excluir: string[] = [], cvText?: string): Scored | null {
  const fields = fieldsOf(raw, cvText);
  if (excluir.some((ex) => fields.some(([, toks]) => contains(toks, tokens(ex))))) return null;
  let score = 0;
  const coincidencias: Match[] = [];
  for (const palabra of palabras) {
    const q = tokens(palabra);
    let best: Campo | undefined;
    for (const [campo, toks] of fields) {
      if ((!best || WEIGHTS[campo] > WEIGHTS[best]) && contains(toks, q)) best = campo;
    }
    if (best) {
      score += WEIGHTS[best];
      coincidencias.push({ palabra, campo: best });
    }
  }
  return score > 0 ? { score, coincidencias } : null;
}

export function rank(raws: any[], palabras: string[], excluir: string[] = [], cvById?: Map<string, string>): Ranked[] {
  const byId = new Map<string, Ranked>();
  for (const raw of raws) {
    const id = String(raw.id);
    const s = scoreCandidate(raw, palabras, excluir, cvById?.get(id));
    if (!s) continue;
    const vacante = { id: label(raw.vacanteId), nombre: label(raw.vacanteNombre) };
    const prev = byId.get(id);
    if (!prev) {
      byId.set(id, { raw, ...s, vacantes: [vacante] });
      continue;
    }
    if (!prev.vacantes.some((v) => v.id === vacante.id)) prev.vacantes.push(vacante);
    if (s.score > prev.score) Object.assign(prev, { raw, score: s.score, coincidencias: s.coincidencias });
  }
  const date = (r: Ranked) => normalizeHrDate(r.raw.fechaPostulacion) ?? "";
  return [...byId.values()].sort((a, b) => b.score - a.score || date(b).localeCompare(date(a)));
}
