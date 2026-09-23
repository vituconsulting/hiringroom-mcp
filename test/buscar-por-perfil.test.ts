import { describe, expect, it } from "vitest";
import { pipelinesRaw, postulantRaw } from "./fixtures.js";
import { connect, FakeHr } from "./helpers/harness.js";
import { minimalPdf } from "./helpers/pdf.js";
import { AuthError } from "../src/errors.js";

const blank = { experienciasLaborales: [], estudios: [], tags: [], direccion: {}, presentacionPostulante: "" };

function pool() {
  return [
    postulantRaw({ id: "A" }),
    postulantRaw({ id: "B", ...blank, presentacionPostulante: "soldador aprendiz" }),
    postulantRaw({ id: "C", ...blank, presentacionPostulante: "chofer" }),
    postulantRaw({ id: "D", ...blank }),
  ];
}

describe("buscar_por_perfil", () => {
  it("requires a scope", async () => {
    const t = await connect(new FakeHr({}));
    const r = await t.call("buscar_por_perfil", { palabras: ["soldador"] });
    expect(r).toMatchObject({ isError: true });
    expect(r.text).toMatch(/acotá por vacante o fechas/);
  });

  it("ranks matches in a vacancy with reasons and scan counts", async () => {
    const hr = new FakeHr({ "/postulants/": { total: 4, totalPaginas: 1, curriculums: pool() } });
    const t = await connect(hr);
    const r = await t.call("buscar_por_perfil", { palabras: ["soldador", "neuquen"], vacante_id: "v1" });
    expect(hr.calls[0].query).toMatchObject({ vacancyId: "v1", page: 0, pageSize: 100 });
    expect(r.json).toMatchObject({ escaneados: 4, total_en_alcance: 4, total_coincidencias: 2, completo: true });
    expect(r.json.items.map((x: any) => x.id)).toEqual(["A", "B"]);
    expect(r.json.items[0]).toMatchObject({ score: 4, coincidencias: [{ palabra: "soldador", campo: "puesto" }, { palabra: "neuquen", campo: "ubicacion" }] });
    expect(r.text).not.toContain("30000000");
  });

  it("uses a date range and stage, and flags partial scans", async () => {
    const hr = new FakeHr({
      "/pipeline/": pipelinesRaw(),
      "/postulants/": (q: Record<string, unknown>) => ({ total: 5000, totalPaginas: 50, curriculums: q.page === 0 ? pool() : [] }),
    });
    const t = await connect(hr, { limits: { perfilMaxScan: 200 } });
    const r = await t.call("buscar_por_perfil", { palabras: ["soldador"], desde: "2026-08-01", hasta: "2026-08-31", etapa: "Entrevista" });
    expect(hr.calls.find((c) => c.path === "/postulants/")!.query).toMatchObject({ stage: 2, createdFrom: 1785553200 });
    expect(r.json.completo).toBe(false);
    expect(r.json.total_en_alcance).toBe(5000);
    expect(r.json.advertencias.join()).toMatch(/de 5000/);
  });

  it("re-scores the top matches with CV text when incluir_cv", async () => {
    const hr = new FakeHr(
      {
        "/postulants/": { total: 2, totalPaginas: 1, curriculums: [postulantRaw({ id: "B", ...blank, presentacionPostulante: "soldador" }), postulantRaw({ id: "E", ...blank, presentacionPostulante: "soldador" })] },
        "/postulants/B/files": { archivos: [{ fileId: "b.pdf" }] },
        "/postulants/E/files": { archivos: [] },
      },
      { "/postulants/B/file/b.pdf": { contentType: "application/pdf", bytes: minimalPdf("Soldador TIG certificado") } },
    );
    const t = await connect(hr);
    const r = await t.call("buscar_por_perfil", { palabras: ["soldador", "tig"], vacante_id: "v1", incluir_cv: true });
    expect(r.json.items[0]).toMatchObject({ id: "B", score: 2 });
    expect(r.json.advertencias.join()).toMatch(/1 CV/);
  });

  it("throws AuthError when CV fetch fails due to invalid credentials", async () => {
    const hr = new FakeHr(
      {
        "/postulants/": { total: 1, totalPaginas: 1, curriculums: [postulantRaw({ id: "B", ...blank, presentacionPostulante: "soldador" })] },
        "/postulants/B/files": new AuthError("Unauthorized"),
      },
    );
    const t = await connect(hr);
    const r = await t.call("buscar_por_perfil", { palabras: ["soldador"], vacante_id: "v1", incluir_cv: true });
    expect(r).toMatchObject({ isError: true });
    expect(r.text).toMatch(/credenciales de HiringRoom inválidas/);
  });
});
