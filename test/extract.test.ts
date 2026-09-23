import { describe, expect, it, vi } from "vitest";
import { InputError } from "../src/errors.js";
import { minimalPdf } from "./helpers/pdf.js";

const mammothMock = vi.fn(async () => ({ value: "Soldador   TIG\n\n\n\nNeuquén" }));
vi.mock("mammoth", () => ({ default: { extractRawText: mammothMock } }));

const { assertPdftotext, cleanText, detectKind, extractText, truncate } = await import("../src/cv/extract.js");

describe("cv extract", () => {
  it("finds pdftotext", async () => {
    await expect(assertPdftotext()).resolves.toBeUndefined();
  });

  it("detects kinds by magic bytes", () => {
    expect(detectKind(Buffer.from("%PDF-1.7"))).toBe("pdf");
    expect(detectKind(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0]))).toBe("docx");
    expect(detectKind(Buffer.from("GIF89a"))).toBe("otro");
  });

  it("extracts PDF text", async () => {
    expect(await extractText(minimalPdf("Soldador calificado Neuquen"))).toContain("Soldador calificado Neuquen");
  });

  it("extracts DOCX text via mammoth and cleans whitespace", async () => {
    expect(await extractText(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0]))).toBe("Soldador TIG\n\nNeuquén");
  });

  it("rejects unsupported formats", async () => {
    await expect(extractText(Buffer.from("GIF89a"))).rejects.toBeInstanceOf(InputError);
  });

  it("cleans and truncates", () => {
    expect(cleanText(" a \t b \r\n\n\n\n c ")).toBe("a b\n\nc");
    expect(truncate("abcdef", 4)).toEqual({ texto: "abcd", truncado: true });
    expect(truncate("abc", 4)).toEqual({ texto: "abc", truncado: false });
  });

  it("wraps corrupted PDF in InputError", async () => {
    const corruptedPdf = Buffer.from("%PDF-1.4\ngarbage");
    await expect(extractText(corruptedPdf)).rejects.toThrow(InputError);
    await expect(extractText(corruptedPdf)).rejects.toThrow(/no se pudo leer/);
  });

  it("wraps mammoth failures in InputError", async () => {
    vi.mocked(mammothMock).mockRejectedValueOnce(new Error("bad zip"));
    const docxBuffer = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0]);
    const err = await extractText(docxBuffer).catch((e) => e);
    expect(err).toBeInstanceOf(InputError);
    expect(err.message).toMatch(/no se pudo leer/);
  });
});
