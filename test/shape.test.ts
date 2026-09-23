import { describe, expect, it } from "vitest";
import { compact, label, personName, place, siNo, trimToSize, jsonBytes } from "../src/shape/common.js";
import { aniosExperiencia, postulantProfile, postulantSummary } from "../src/shape/postulant.js";
import { vacancyDetail, vacancySummary } from "../src/shape/vacancy.js";
import { NOW, postulantRaw, vacancyRaw } from "./fixtures.js";

describe("common", () => {
  it("compacts nulls, empty strings, arrays and objects recursively", () => {
    expect(compact({ a: null, b: "", c: [], d: {}, e: { f: null, g: 1 }, h: [null, 2], i: 0, j: false })).toEqual({ e: { g: 1 }, h: [2], i: 0, j: false });
  });

  it("extracts labels, names, places and yes/no", () => {
    expect(label({ nombre: "X" })).toBe("X");
    expect(label("  ")).toBeUndefined();
    expect(personName({ nombre: "Ana", apellido: "Paz" })).toBe("Ana Paz");
    expect(place({ ciudad: "Añelo", provincia: "Neuquén", pais: "Argentina" })).toBe("Añelo, Neuquén, Argentina");
    expect(siNo("Sí")).toBe(true);
    expect(siNo("No")).toBe(false);
    expect(siNo(undefined)).toBeUndefined();
  });

  it("trims the longest list until the payload fits", () => {
    const value = { total: 50, items: Array.from({ length: 50 }, (_, i) => ({ i, pad: "x".repeat(100) })) };
    const out = trimToSize(value, 2000);
    expect(jsonBytes(out)).toBeLessThanOrEqual(2000);
    expect(out.recortado).toBe(true);
    expect(out.items.length).toBeLessThan(50);
    expect(value.items).toHaveLength(50); // input untouched
    expect(trimToSize({ a: 1 }, 2000)).toEqual({ a: 1 });
  });
});

describe("vacancy", () => {
  it("summarizes without description or requirements", () => {
    expect(vacancySummary(vacancyRaw())).toEqual({
      id: "6a0000000000000000000001",
      nombre: "Soldador calificado - Añelo",
      estado: "Activa",
      cliente: "Operadora Sur",
      area: "Producción",
      ubicacion: "Añelo, Neuquén, Argentina",
      fecha_creacion: "2026-08-01",
      posiciones: 3,
      prioridad: "Media",
      responsables: ["Ana Paz", "Leo Sur"],
    });
  });

  it("details include description, requirements and pipeline id", () => {
    const d = vacancyDetail(vacancyRaw());
    expect(d).toMatchObject({ descripcion: "Soldadura en planta de tratamiento.", requisitos: "Experiencia en soldadura MIG/TIG.", pipeline_id: "p2", publicada: true });
  });
});

describe("postulant", () => {
  it("computes non-overlapping years of experience", () => {
    const exps = [
      { mesDesde: 1, añoDesde: 2020, mesHasta: 12, añoHasta: 2021, trabajoActual: false },
      { mesDesde: 6, añoDesde: 2021, mesHasta: 6, añoHasta: 2022, trabajoActual: false },
    ];
    expect(aniosExperiencia(exps, NOW)).toBe(2.5);
    expect(aniosExperiencia([], NOW)).toBeUndefined();
  });

  it("summarizes without sensitive fields", () => {
    const s = postulantSummary(postulantRaw(), NOW);
    expect(s).toMatchObject({
      id: "6b0000000000000000000001",
      nombre_completo: "Juan Pérez",
      email: "juan.perez@example.com",
      vacante: { id: "6a0000000000000000000001", nombre: "Soldador calificado - Añelo" },
      etapa: "Nuevo",
      rechazado: false,
      fecha_postulacion: "2026-09-20",
      ubicacion: "Añelo, Neuquén, Argentina",
      ultimo_puesto: { puesto: "Soldador calificado", empresa: "Servicios Petroleros", desde: "2021-06", hasta: "actual" },
      nivel_estudio: "Secundario (Graduado)",
      tags: ["Disponible ya"],
    });
    const text = JSON.stringify(s);
    for (const secret of ["30000000", "01-01-1990", "Masculino", "foto.jpg", "+54299"]) expect(text).not.toContain(secret);
  });

  it("profile hides dni/birth date unless asked; never gender/photo", () => {
    const off = JSON.stringify(postulantProfile(postulantRaw(), NOW, false));
    expect(off).toContain("+5429911111");
    for (const s of ["30000000", "01-01-1990", "Masculino", "foto.jpg"]) expect(off).not.toContain(s);
    const on = JSON.stringify(postulantProfile(postulantRaw(), NOW, true));
    expect(on).toContain("30000000");
    expect(on).toContain("01-01-1990");
    expect(on).not.toContain("Masculino");
    expect(on).not.toContain("foto.jpg");
  });
});
