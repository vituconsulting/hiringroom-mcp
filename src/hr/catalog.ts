import { InputError } from "../errors.js";
import { normalize } from "../text.js";
import type { HrLike } from "./client.js";
import { firstArray } from "./paginate.js";

export class TtlCache {
  private entries = new Map<string, { at: number; value: Promise<unknown> }>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  get<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.entries.get(key);
    if (hit && this.now() - hit.at <= this.ttlMs) return hit.value as Promise<T>;
    const value = load();
    this.entries.set(key, { at: this.now(), value });
    value.catch(() => this.entries.delete(key));
    return value;
  }
}

export interface Stage {
  id: number;
  nombre: string;
}

export interface Pipeline {
  id: string;
  nombre: string;
  etapas: Stage[];
}

const PLACEHOLDER = "---";

export async function getPipelines(hr: HrLike, cache: TtlCache): Promise<Pipeline[]> {
  const raw = await cache.get("pipelines", () => hr.get("/pipeline/"));
  return firstArray(raw).map((p: any) => ({
    id: String(p.id),
    nombre: String(p.nombre ?? ""),
    etapas: (Array.isArray(p.etapas) ? p.etapas : []).map((e: any) => ({ id: Number(e.id), nombre: String(e.nombre ?? "") })),
  }));
}

export function stageName(pipelines: Pipeline[], stageId: number, pipelineId?: string): string | undefined {
  const ordered = [...pipelines].sort((a, b) => Number(b.id === pipelineId) - Number(a.id === pipelineId));
  for (const p of ordered) {
    const s = p.etapas.find((e) => e.id === stageId && e.nombre !== PLACEHOLDER);
    if (s) return s.nombre;
  }
  return undefined;
}

export function resolveStage(pipelines: Pipeline[], input: string): number {
  const trimmed = input.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const wanted = normalize(trimmed);
  const all = pipelines.flatMap((p) => p.etapas).filter((e) => e.nombre !== PLACEHOLDER);
  const ids = [...new Set(all.filter((e) => normalize(e.nombre) === wanted).map((e) => e.id))];
  if (ids.length === 1) return ids[0];
  const valid = [...new Set(all.map((e) => e.nombre))].join(", ");
  if (ids.length === 0) throw new InputError(`etapa desconocida "${input}". Etapas válidas: ${valid}`);
  throw new InputError(`etapa ambigua "${input}" (ids ${ids.join(", ")}); usá el id numérico`);
}
