import { z } from "zod";
import { detectKind, extractText, truncate } from "../cv/extract.js";
import { InputError, NotFoundError } from "../errors.js";
import { firstArray } from "../hr/paginate.js";
import type { ToolContext } from "./context.js";
import { defineTool, enc, orNotFound } from "./define.js";

const MAX_ATTEMPTS = 5;

export async function fetchCvText(ctx: ToolContext, postulanteId: string, fileId?: string): Promise<{ fileId: string; text: string }> {
  const base = `/postulants/${enc(postulanteId)}`;
  let candidates: string[];
  if (fileId) candidates = [fileId];
  else {
    const body = await orNotFound(ctx.hr.get(`${base}/files`), "postulante", postulanteId);
    candidates = (body?.archivos ?? firstArray(body)).map((f: any) => String(f?.fileId ?? "")).filter(Boolean);
  }
  if (!candidates.length) throw new InputError("el postulante no tiene archivos adjuntos");

  for (const fid of candidates.slice(0, MAX_ATTEMPTS)) {
    try {
      const bin = await orNotFound(ctx.hr.getBinary(`${base}/file/${enc(fid)}`, ctx.limits.cvMaxBytes), "archivo", fid);
      if (detectKind(bin.bytes) === "otro" && !fileId) continue;
      const text = await extractText(bin.bytes);
      if (!text && !fileId) continue;
      if (!text && fileId) throw new InputError("el archivo no tiene texto extraíble (posible PDF escaneado)");
      return { fileId: fid, text };
    } catch (err) {
      if (!fileId && (err instanceof NotFoundError || err instanceof InputError)) continue;
      throw err;
    }
  }
  throw new InputError("ningún adjunto es un PDF o DOCX legible");
}

export const leerCv = defineTool({
  name: "leer_cv",
  description:
    "Descarga el CV adjunto de un postulante (PDF o DOCX) y devuelve su texto. Sin file_id toma el primer adjunto legible. Los file_id salen de ver_postulante.",
  input: {
    postulante_id: z.string().min(1),
    file_id: z.string().optional(),
    max_caracteres: z.number().int().min(1000).max(60_000).optional().describe("por defecto 20000"),
  },
  maxBytes: (limits) => limits.cvMaxChars * 4 + 2000,
  async run({ postulante_id, file_id, max_caracteres }, ctx) {
    const max = Math.min(max_caracteres ?? ctx.limits.cvDefaultChars, ctx.limits.cvMaxChars);
    const { fileId, text } = await fetchCvText(ctx, postulante_id, file_id);
    const { texto, truncado } = truncate(text, max);
    return { postulante_id, file_id: fileId, caracteres: text.length, truncado, texto };
  },
});
