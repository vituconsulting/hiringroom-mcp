import { describe, expect, it } from "vitest";
import { UpstreamError } from "../src/errors.js";
import { postulantRaw, vacancyRaw } from "./fixtures.js";
import { connect, FakeHr } from "./helpers/harness.js";

describe("reporte_contrataciones", () => {
  it("splits into 30-day windows (DD-MM-YYYY) and totals by vacancy and month", async () => {
    const hr = new FakeHr({
      "/postulants/hired/": (q: Record<string, unknown>) =>
        q.start === "01-07-2026"
          ? { total: 2, totalPaginas: 1, curriculums: [postulantRaw({ id: "h1", fechaIngreso: "05-07-2026" }), postulantRaw({ id: "h2", vacanteId: "v9", vacanteNombre: "Chofer", fechaIngreso: "20-07-2026" })] }
          : { total: 1, totalPaginas: 1, curriculums: [postulantRaw({ id: "h3", fechaIngreso: "02-08-2026" })] },
    });
    const t = await connect(hr);
    const r = await t.call("reporte_contrataciones", { desde: "2026-07-01", hasta: "2026-08-15" });
    expect(hr.calls.map((c) => [c.query.start, c.query.end])).toEqual([["01-07-2026", "30-07-2026"], ["31-07-2026", "15-08-2026"]]);
    expect(r.json).toMatchObject({ total: 3, completo: true });
    expect(r.json.por_vacante).toEqual([{ vacante: "Soldador calificado - Añelo", cantidad: 2 }, { vacante: "Chofer", cantidad: 1 }]);
    expect(r.json.por_mes).toEqual([{ mes: "2026-07", cantidad: 2 }, { mes: "2026-08", cantidad: 1 }]);
    expect(r.json.items[0]).toMatchObject({ id: "h1", fecha_contratacion: "2026-07-05" });
  });

  it("keeps going when a window fails", async () => {
    const hr = new FakeHr({
      "/postulants/hired/": (q: Record<string, unknown>) => (q.start === "01-07-2026" ? new UpstreamError("x") : { total: 0, totalPaginas: 0, curriculums: [] }),
    });
    const r = await (await connect(hr)).call("reporte_contrataciones", { desde: "2026-07-01", hasta: "2026-08-15" });
    expect(r.json.completo).toBe(false);
    expect(r.json.advertencias.join()).toMatch(/01-07-2026/);
  });

  it("caps the range at 365 days", async () => {
    const r = await (await connect(new FakeHr({}))).call("reporte_contrataciones", { desde: "2025-01-01", hasta: "2026-09-01" });
    expect(r.text).toMatch(/365 días/);
  });
});

describe("reporte_movimientos_vacantes", () => {
  it("uses 7-day windows and groups by status", async () => {
    const hr = new FakeHr({
      "/vacancies/byChangedStatus": (q: Record<string, unknown>) =>
        q.start === "01-09-2026"
          ? { total: 2, totalPaginas: 1, vacantes: [vacancyRaw({ id: "a", estadoActual: "Cerrada" }), vacancyRaw({ id: "b", estadoActual: "Activa" })] }
          : { total: 1, totalPaginas: 1, vacantes: [vacancyRaw({ id: "c", estadoActual: "Cerrada" })] },
    });
    const r = await (await connect(hr)).call("reporte_movimientos_vacantes", { desde: "2026-09-01", hasta: "2026-09-10" });
    expect(hr.calls.map((c) => c.query.start)).toEqual(["01-09-2026", "08-09-2026"]);
    expect(r.json.por_estado).toEqual([{ estado: "Cerrada", cantidad: 2 }, { estado: "Activa", cantidad: 1 }]);
    expect(r.json.total).toBe(3);
  });

  it("caps the range at 90 days", async () => {
    const r = await (await connect(new FakeHr({}))).call("reporte_movimientos_vacantes", { desde: "2026-01-01", hasta: "2026-09-01" });
    expect(r.text).toMatch(/90 días/);
  });
});

describe("postulaciones_por_dia", () => {
  it("counts per day and ranks vacancies without returning postulants", async () => {
    const hr = new FakeHr({
      "/postulants/byDay/": (q: Record<string, unknown>) =>
        q.day === "21-09-2026"
          ? { total: 2, totalPaginas: 1, curriculums: [postulantRaw({ id: "x" }), postulantRaw({ id: "y", vacanteId: "v9", vacanteNombre: "Chofer" })] }
          : { total: 1, totalPaginas: 1, curriculums: [postulantRaw({ id: "z" })] },
    });
    const r = await (await connect(hr)).call("postulaciones_por_dia", { desde: "2026-09-21", hasta: "2026-09-22" });
    expect(r.json.por_dia).toEqual([{ fecha: "2026-09-21", cantidad: 2 }, { fecha: "2026-09-22", cantidad: 1 }]);
    expect(r.json.top_vacantes[0]).toEqual({ vacante_id: "6a0000000000000000000001", vacante: "Soldador calificado - Añelo", cantidad: 2 });
    expect(r.json.total).toBe(3);
    expect(r.text).not.toContain("juan.perez@example.com");
  });

  it("caps the range at 31 days", async () => {
    const r = await (await connect(new FakeHr({}))).call("postulaciones_por_dia", { desde: "2026-08-01", hasta: "2026-09-10" });
    expect(r.text).toMatch(/31 días/);
  });
});
