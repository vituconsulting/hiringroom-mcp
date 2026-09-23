import { describe, expect, it } from "vitest";
import { InputError } from "../src/errors.js";
import { getPipelines, resolveStage, stageName, TtlCache, type Pipeline } from "../src/hr/catalog.js";
import type { HrGetOptions, HrLike, Query } from "../src/hr/client.js";
import { normalize } from "../src/text.js";

const PIPES: Pipeline[] = [
  { id: "p1", nombre: "Default", etapas: [{ id: 0, nombre: "NUEVO" }, { id: 2, nombre: "ENTREVISTA" }, { id: 7, nombre: "---" }] },
  { id: "p2", nombre: "Pipeline vigente", etapas: [{ id: 0, nombre: "NUEVO" }, { id: 2, nombre: "ENTREVISTA" }, { id: 7, nombre: "PRESENTADO" }] },
];

describe("normalize", () => {
  it("strips accents, case and extra spaces", () => {
    expect(normalize("  EN REVISIÓN  Ñandú ")).toBe("en revision nandu");
  });
});

describe("TtlCache", () => {
  it("caches until the TTL expires", async () => {
    let t = 0;
    let loads = 0;
    const cache = new TtlCache(1000, () => t);
    const load = async () => ++loads;
    expect(await cache.get("k", load)).toBe(1);
    expect(await cache.get("k", load)).toBe(1);
    t = 1001;
    expect(await cache.get("k", load)).toBe(2);
  });
});

describe("pipelines", () => {
  it("loads and normalizes pipelines once", async () => {
    let calls = 0;
    const hr: HrLike = {
      async get<T = any>(_path: string, _query?: Query, _opts?: HrGetOptions) {
        calls++;
        return [{ id: "p1", nombre: "Default", descripcion: "x", estado: 1, etapas: [{ id: 0, nombre: "NUEVO" }] }] as T;
      },
      async getBinary() {
        throw new Error("unused");
      },
    };
    const cache = new TtlCache(60_000);
    expect(await getPipelines(hr, cache)).toEqual([{ id: "p1", nombre: "Default", etapas: [{ id: 0, nombre: "NUEVO" }] }]);
    await getPipelines(hr, cache);
    expect(calls).toBe(1);
  });

  it("names stages, preferring the vacancy pipeline", () => {
    expect(stageName(PIPES, 7, "p2")).toBe("PRESENTADO");
    expect(stageName(PIPES, 7)).toBe("PRESENTADO");
    expect(stageName(PIPES, 2)).toBe("ENTREVISTA");
    expect(stageName(PIPES, 99)).toBeUndefined();
  });

  it("resolves stage names and ids", () => {
    expect(resolveStage(PIPES, "Entrevista")).toBe(2);
    expect(resolveStage(PIPES, "presentado")).toBe(7);
    expect(resolveStage(PIPES, "7")).toBe(7);
    expect(() => resolveStage(PIPES, "Psicotécnico")).toThrow(InputError);
    expect(() => resolveStage(PIPES, "Psicotécnico")).toThrow(/NUEVO/);
    expect(() => resolveStage(PIPES, "---")).toThrow(InputError);
  });
});
