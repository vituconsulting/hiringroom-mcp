import { InputError } from "../errors.js";

// America/Argentina/Buenos_Aires has had no DST since 2009: fixed UTC-3.
const OFFSET = "-03:00";
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

export interface DateWindow {
  desde: string;
  hasta: string;
}

function utcMs(iso: string): number {
  return Date.parse(`${iso}T00:00:00Z`);
}

export function assertIso(s: string): void {
  const ok = ISO.test(s) && !Number.isNaN(utcMs(s)) && new Date(utcMs(s)).toISOString().slice(0, 10) === s;
  if (!ok) throw new InputError(`fecha inválida "${s}", usar YYYY-MM-DD`);
}

export function epochStart(iso: string): number {
  assertIso(iso);
  return Date.parse(`${iso}T00:00:00${OFFSET}`) / 1000;
}

export function epochEnd(iso: string): number {
  return epochStart(iso) + 86_399;
}

export function toDmy(iso: string): string {
  assertIso(iso);
  const [y, m, d] = iso.split("-");
  return `${d}-${m}-${y}`;
}

export function addDays(iso: string, n: number): string {
  return new Date(utcMs(iso) + n * DAY_MS).toISOString().slice(0, 10);
}

export function daysInclusive(desde: string, hasta: string): number {
  return Math.round((utcMs(hasta) - utcMs(desde)) / DAY_MS) + 1;
}

export function assertRange(desde: string, hasta: string, maxDays?: number): void {
  assertIso(desde);
  assertIso(hasta);
  if (desde > hasta) throw new InputError("`desde` no puede ser posterior a `hasta`");
  if (maxDays !== undefined && daysInclusive(desde, hasta) > maxDays) {
    throw new InputError(`el rango máximo es de ${maxDays} días`);
  }
}

export function splitWindows(desde: string, hasta: string, maxDays: number): DateWindow[] {
  assertRange(desde, hasta);
  const out: DateWindow[] = [];
  for (let start = desde; start <= hasta; ) {
    let end = addDays(start, maxDays - 1);
    if (end > hasta) end = hasta;
    out.push({ desde: start, hasta: end });
    start = addDays(end, 1);
  }
  return out;
}

export function eachDay(desde: string, hasta: string): string[] {
  assertRange(desde, hasta);
  const out: string[] = [];
  for (let d = desde; d <= hasta; d = addDays(d, 1)) out.push(d);
  return out;
}

export function normalizeHrDate(v: unknown): string | undefined {
  if (typeof v !== "string" || !v.trim()) return undefined;
  const s = v.trim();
  const dmy = /^(\d{2})[-/](\d{2})[-/](\d{4})/.exec(s);
  if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return s;
}
