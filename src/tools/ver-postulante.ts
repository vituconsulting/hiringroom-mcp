import { z } from "zod";
import { firstArray } from "../hr/paginate.js";
import { label } from "../shape/common.js";
import { postulantProfile } from "../shape/postulant.js";
import { defineTool, enc, orNotFound, settle, unwrap } from "./define.js";

export const verPostulante = defineTool({
  name: "ver_postulante",
  description:
    "Perfil completo de un postulante: experiencia, estudios, conocimientos, comentarios, referencias, disponibilidad, historial (records) y lista de archivos adjuntos con su file_id (para leer_cv). DNI, CUIL y fecha de nacimiento solo con incluir_sensibles: true.",
  input: {
    id: z.string().min(1),
    incluir_sensibles: z.boolean().default(false),
  },
  async run({ id, incluir_sensibles }, ctx) {
    const base = `/postulants/${enc(id)}`;
    const raw = unwrap(await orNotFound(ctx.hr.get(base), "postulante", id), "postulant", "postulante");
    const [records, files] = await Promise.all([settle(ctx.hr.get(`${base}/records`)), settle(ctx.hr.get(`${base}/files`))]);
    const advertencias: string[] = [];
    if (!records.ok) advertencias.push(`registros: ${records.error}`);
    if (!files.ok) advertencias.push(`archivos: ${files.error}`);
    return {
      postulante: postulantProfile(raw, ctx.now(), incluir_sensibles),
      registros: records.ok ? (records.value?.records ?? firstArray(records.value)) : undefined,
      archivos: files.ok
        ? (files.value?.archivos ?? firstArray(files.value)).map((f: any) => ({ file_id: label(f?.fileId), descripcion: label(f?.description) }))
        : undefined,
      advertencias,
    };
  },
});
