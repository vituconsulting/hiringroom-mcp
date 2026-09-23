import { describe, expect, it } from "vitest";
import { pipelinesRaw, postulantRaw } from "./fixtures.js";
import { connect, FakeHr } from "./helpers/harness.js";

const P = "6b0000000000000000000001";

describe("buscar_postulantes", () => {
  it("resolves stage names and maps filters", async () => {
    const hr = new FakeHr({
      "/pipeline/": pipelinesRaw(),
      "/postulants/": { total: 1, totalPaginas: 1, curriculums: [postulantRaw()] },
    });
    const t = await connect(hr);
    const r = await t.call("buscar_postulantes", { vacante_id: "v1", etapa: "entrevista", desde: "2026-09-01", hasta: "2026-09-01" });
    const q = hr.calls.find((c) => c.path === "/postulants/")!.query;
    expect(q).toMatchObject({ vacancyId: "v1", stage: 2, createdFrom: 1788231600, createdTo: 1788317999, page: 0, pageSize: 20 });
    expect(r.json).toMatchObject({ total: 1, pagina: 1, hay_mas: false });
    expect(r.json.items[0]).toMatchObject({ id: P, nombre_completo: "Juan Pérez" });
    expect(r.text).not.toContain("30000000");
  });

  it("lists valid stages on an unknown stage name", async () => {
    const t = await connect(new FakeHr({ "/pipeline/": pipelinesRaw() }));
    const r = await t.call("buscar_postulantes", { etapa: "psicotécnico" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Etapas válidas: .*ENTREVISTA/);
  });
});

describe("ver_postulante", () => {
  const routes = {
    [`/postulants/${P}`]: { postulant: { ...postulantRaw(), comentarios: [{ texto: "Buen perfil" }], conocimientos: [{ nombre: "TIG" }] } },
    [`/postulants/${P}/records`]: { records: [{ idVacante: "v1", descripcion: "Pasó a Entrevista", fechaCreacion: "21-09-2026", horaCreacion: "10:00" }] },
    [`/postulants/${P}/files`]: { result: "success", archivos: [{ fileId: "f1.pdf", description: "no especificado" }] },
  };

  it("returns profile, records and files without sensitive fields by default", async () => {
    const t = await connect(new FakeHr(routes));
    const r = await t.call("ver_postulante", { id: P });
    expect(r.json.postulante).toMatchObject({ nombre_completo: "Juan Pérez", telefonoCelular: "+5429911111", comentarios: [{ texto: "Buen perfil" }] });
    expect(r.json.registros[0]).toMatchObject({ descripcion: "Pasó a Entrevista" });
    expect(r.json.archivos).toEqual([{ file_id: "f1.pdf", descripcion: "no especificado" }]);
    expect(r.text).not.toContain("30000000");
    expect(r.text).not.toContain("Masculino");
  });

  it("includes dni and birth date only when asked", async () => {
    const t = await connect(new FakeHr(routes));
    const r = await t.call("ver_postulante", { id: P, incluir_sensibles: true });
    expect(r.json.postulante).toMatchObject({ dni: "30000000", fechaNacimiento: "01-01-1990" });
    expect(r.text).not.toContain("Masculino");
  });

  it("reports missing postulants", async () => {
    const t = await connect(new FakeHr({}));
    expect(await t.call("ver_postulante", { id: "nope" })).toMatchObject({ isError: true, text: "no existe postulante `nope`" });
  });
});
