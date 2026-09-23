import { describe, expect, it } from "vitest";
import { UpstreamError } from "../src/errors.js";
import { pipelinesRaw, vacancyRaw } from "./fixtures.js";
import { connect, FakeHr } from "./helpers/harness.js";

const V = "6a0000000000000000000001";

describe("buscar_vacantes", () => {
  it("maps filters to HiringRoom params and returns summaries", async () => {
    const hr = new FakeHr({ "/vacancies": { total: 25, totalPaginas: 2, page: 0, pageSize: 20, vacantes: [vacancyRaw()] } });
    const t = await connect(hr);
    const r = await t.call("buscar_vacantes", { estado: ["Activa"], creada_desde: "2026-08-01", creada_hasta: "2026-08-31" });
    expect(hr.calls[0].query).toMatchObject({ listStatus: "Activa", createdFrom: 1785553200, createdTo: 1788231599, page: 0, pageSize: 20 });
    expect(r.json).toMatchObject({ total: 25, pagina: 1, hay_mas: true });
    expect(r.json.items[0]).toMatchObject({ id: V, estado: "Activa", cliente: "Operadora Sur" });
    expect(r.json.items[0].descripcion).toBeUndefined();
  });

  it("filters by name text across pages", async () => {
    const all = [vacancyRaw({ id: "a", nombre: "Soldador" }), vacancyRaw({ id: "b", nombre: "Chofer" }), vacancyRaw({ id: "c", nombre: "Ayudante de SOLDADURA" })];
    const hr = new FakeHr({ "/vacancies": { total: 3, totalPaginas: 1, vacantes: all } });
    const t = await connect(hr);
    const r = await t.call("buscar_vacantes", { texto: "sóldad" });
    expect(r.json.items.map((v: any) => v.id)).toEqual(["a", "c"]);
    expect(r.json).toMatchObject({ total: 2, completo: true });
  });

  it("rejects inverted ranges", async () => {
    const t = await connect(new FakeHr({}));
    const r = await t.call("buscar_vacantes", { creada_desde: "2026-09-10", creada_hasta: "2026-09-01" });
    expect(r).toMatchObject({ isError: true });
    expect(r.text).toMatch(/posterior/);
  });
});

describe("ver_vacante", () => {
  const routes = {
    [`/vacancies/${V}`]: vacancyRaw(),
    [`/vacancies/${V}/pipeline/counts`]: { total: 12, pipeline: { total: 10, stage: [{ id: 0, total: 6 }, { id: 7, total: 4 }] }, rejecteds: { total: 2, stage: [] } },
    [`/vacancies/${V}/notes`]: { result: [{ nota: "Priorizar Añelo" }] },
    [`/vacancies/${V}/questions`]: { preguntas: [{ pregunta: "¿Carnet?" }] },
    [`/vacancies/${V}/requirements`]: { requisitos: [{ nombre: "Secundario" }] },
    "/pipeline/": pipelinesRaw(),
  };

  it("returns detail, stage counts by name, notes and questions", async () => {
    const t = await connect(new FakeHr(routes));
    const r = await t.call("ver_vacante", { id: V });
    expect(r.json.vacante).toMatchObject({ id: V, descripcion: "Soldadura en planta de tratamiento." });
    expect(r.json.pipeline).toEqual({ total: 10, rechazados: 2, etapas: [{ etapa: "NUEVO", cantidad: 6 }, { etapa: "PRESENTADO", cantidad: 4 }] });
    expect(r.json.notas).toEqual([{ nota: "Priorizar Añelo" }]);
    expect(r.json.estadisticas).toBeUndefined();
  });

  it("stats are opt-in and degrade on timeout", async () => {
    const t = await connect(new FakeHr({ ...routes, [`/vacancies/${V}/stats`]: () => new UpstreamError("timeout") }));
    const r = await t.call("ver_vacante", { id: V, incluir_estadisticas: true });
    expect(r.json.estadisticas).toBe("no disponible (timeout)");
  });

  it("reports missing vacancies clearly and keeps partial sections", async () => {
    const t = await connect(new FakeHr({ "/pipeline/": pipelinesRaw() }));
    const r = await t.call("ver_vacante", { id: "zzz" });
    expect(r).toMatchObject({ isError: true, text: "no existe vacante `zzz`" });

    const partial = { ...routes };
    delete (partial as Record<string, unknown>)[`/vacancies/${V}/notes`];
    const t2 = await connect(new FakeHr(partial));
    const r2 = await t2.call("ver_vacante", { id: V });
    expect(r2.json.advertencias.join()).toMatch(/notas/);
  });

  it("degrades stage names gracefully when pipeline catalog fails", async () => {
    const t = await connect(new FakeHr({ ...routes, "/pipeline/": () => new UpstreamError("timeout") }));
    const r = await t.call("ver_vacante", { id: V });
    expect(r.json.vacante).toMatchObject({ id: V });
    expect(r.json.pipeline.etapas).toEqual([{ etapa: "etapa 0", cantidad: 6 }, { etapa: "etapa 7", cantidad: 4 }]);
    expect(r.json.advertencias.join()).toMatch(/catalogo de etapas/);
  });
});
