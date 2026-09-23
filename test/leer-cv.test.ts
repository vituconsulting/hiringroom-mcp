import { describe, expect, it } from "vitest";
import { connect, FakeHr } from "./helpers/harness.js";
import { minimalPdf } from "./helpers/pdf.js";

const P = "p1";
const files = (ids: string[]) => ({ [`/postulants/${P}/files`]: { result: "success", archivos: ids.map((fileId) => ({ fileId, description: "no especificado" })) } });
const pdf = { contentType: "application/pdf", bytes: minimalPdf("Soldador calificado con certificacion API 1104") };
const gif = { contentType: "image/gif", bytes: Buffer.from("GIF89a....") };

describe("leer_cv", () => {
  it("reads the first PDF/DOCX attachment, skipping others", async () => {
    const hr = new FakeHr(files(["foto.gif", "cv.pdf"]), { [`/postulants/${P}/file/foto.gif`]: gif, [`/postulants/${P}/file/cv.pdf`]: pdf });
    const t = await connect(hr);
    const r = await t.call("leer_cv", { postulante_id: P });
    expect(r.json).toMatchObject({ postulante_id: P, file_id: "cv.pdf", truncado: false });
    expect(r.json.texto).toContain("API 1104");
  });

  it("truncates to max_caracteres", async () => {
    const t = await connect(new FakeHr(files(["cv.pdf"]), { [`/postulants/${P}/file/cv.pdf`]: pdf }));
    const r = await t.call("leer_cv", { postulante_id: P, max_caracteres: 1000 });
    expect(r.json.truncado).toBe(false);
    const r2 = await (await connect(new FakeHr(files(["cv.pdf"]), { [`/postulants/${P}/file/cv.pdf`]: pdf }), { limits: { cvMaxChars: 10 } })).call("leer_cv", { postulante_id: P });
    expect(r2.json).toMatchObject({ truncado: true });
    expect(r2.json.texto).toHaveLength(10);
  });

  it("errors clearly when there is nothing readable", async () => {
    const none = await connect(new FakeHr(files([])));
    expect(await none.call("leer_cv", { postulante_id: P })).toMatchObject({ isError: true, text: "el postulante no tiene archivos adjuntos" });
    const onlyGif = await connect(new FakeHr(files(["foto.gif"]), { [`/postulants/${P}/file/foto.gif`]: gif }));
    expect(await onlyGif.call("leer_cv", { postulante_id: P })).toMatchObject({ isError: true, text: "ningún adjunto es PDF o DOCX" });
    const explicit = await connect(new FakeHr(files(["foto.gif"]), { [`/postulants/${P}/file/foto.gif`]: gif }));
    expect((await explicit.call("leer_cv", { postulante_id: P, file_id: "foto.gif" })).text).toMatch(/no soportado/);
  });
});
