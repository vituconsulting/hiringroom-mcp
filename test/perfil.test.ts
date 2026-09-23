import { describe, expect, it } from "vitest";
import { rank, scoreCandidate } from "../src/search/perfil.js";
import { postulantRaw } from "./fixtures.js";

describe("scoreCandidate", () => {
  it("matches accent/case-insensitive prefixes and weights by field", () => {
    const s = scoreCandidate(postulantRaw(), ["SOLDAD", "neuquen"]);
    expect(s).toEqual({
      score: 3 + 1,
      coincidencias: [
        { palabra: "SOLDAD", campo: "puesto" },
        { palabra: "neuquen", campo: "ubicacion" },
      ],
    });
  });

  it("matches phrases as consecutive tokens", () => {
    expect(scoreCandidate(postulantRaw(), ["soldador calificado"])?.score).toBe(3);
    expect(scoreCandidate(postulantRaw(), ["calificado soldador"])).toBeNull();
  });

  it("returns null when nothing matches or an exclusion matches", () => {
    expect(scoreCandidate(postulantRaw(), ["electricista"])).toBeNull();
    expect(scoreCandidate(postulantRaw(), ["soldador"], ["ductos"])).toBeNull(); // matches an experience description
  });

  it("uses CV text with weight 1", () => {
    expect(scoreCandidate(postulantRaw(), ["api 1104"])).toBeNull();
    expect(scoreCandidate(postulantRaw(), ["api 1104"], [], "Certificación API 1104 vigente")).toEqual({
      score: 1,
      coincidencias: [{ palabra: "api 1104", campo: "cv" }],
    });
  });

  it("scores education titles, areas and tags", () => {
    expect(scoreCandidate(postulantRaw(), ["tecnico mecanico"])?.coincidencias[0].campo).toBe("titulo_estudio");
    expect(scoreCandidate(postulantRaw(), ["oil"])?.coincidencias[0].campo).toBe("area");
    expect(scoreCandidate(postulantRaw(), ["disponible"])?.coincidencias[0].campo).toBe("tag");
  });
});

describe("rank", () => {
  it("dedups by postulant id, keeps best score, lists vacancies, sorts by score then recency", () => {
    const a1 = postulantRaw({ id: "A", vacanteId: "v1", vacanteNombre: "V1", fechaPostulacion: "01-09-2026" });
    const a2 = postulantRaw({ id: "A", vacanteId: "v2", vacanteNombre: "V2", presentacionPostulante: "neuquen" });
    const b = postulantRaw({ id: "B", experienciasLaborales: [], estudios: [], tags: [], direccion: {}, presentacionPostulante: "soldador", fechaPostulacion: "22-09-2026" });
    const c = postulantRaw({ id: "C", experienciasLaborales: [], estudios: [], tags: [], direccion: {}, presentacionPostulante: "soldador", fechaPostulacion: "10-09-2026" });
    const d = postulantRaw({ id: "D", experienciasLaborales: [], estudios: [], tags: [], direccion: {}, presentacionPostulante: "cocinero" });
    const r = rank([a1, a2, b, c, d], ["soldador"]);
    expect(r.map((x) => x.raw.id)).toEqual(["A", "B", "C"]);
    expect(r[0].vacantes).toEqual([{ id: "v1", nombre: "V1" }, { id: "v2", nombre: "V2" }]);
  });

  it("applies CV text per postulant", () => {
    const x = postulantRaw({ id: "X", experienciasLaborales: [], estudios: [], tags: [], direccion: {}, presentacionPostulante: "" });
    expect(rank([x], ["tig"])).toEqual([]);
    expect(rank([x], ["tig"], [], new Map([["X", "Soldadura TIG"]]))[0].score).toBe(1);
  });
});
