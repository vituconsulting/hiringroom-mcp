// Manual read-only check against the real HiringRoom API. Prints counts, timings and key names only.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { memoryAudit } from "../src/audit.js";
import { loadConfig } from "../src/config.js";
import { assertPdftotext } from "../src/cv/extract.js";
import { TtlCache } from "../src/hr/catalog.js";
import { HrClient } from "../src/hr/client.js";
import { addDays } from "../src/hr/dates.js";
import { firstArray } from "../src/hr/paginate.js";
import { createServer } from "../src/server.js";

const keys = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? Object.keys(v).sort() : typeof v);

async function main() {
  const config = loadConfig();
  await assertPdftotext();
  const hr = new HrClient({ credentials: config.hr, concurrency: config.limits.concurrency, timeoutMs: config.limits.requestTimeoutMs });
  const ctx = { hr, cache: new TtlCache(config.limits.cacheTtlMs), limits: config.limits, now: () => new Date() };

  // 1. Raw shapes the shapers guess at (keys only). Failures print the API's validation message, never data.
  const safe = (p: Promise<any>) => p.catch((e: Error) => ({ __error: e.message }));
  const allVacs = firstArray(await safe(hr.get("/vacancies", { page: 0, pageSize: 100 })));
  const vac = allVacs.find((v: any) => v.estadoActual === "Activa") ?? allVacs[0];
  const today = new Date().toISOString().slice(0, 10);
  const dmy = (iso: string) => iso.split("-").reverse().join("-");
  const hiredBody = await safe(hr.get("/postulants/hired/", { start: dmy(addDays(today, -29)), end: dmy(today), page: 0, pageSize: 10 }));
  const moved = await safe(hr.get("/vacancies/byChangedStatus", { start: dmy(addDays(today, -6)), end: dmy(today), page: 0, pageSize: 10 }));
  const counts = vac ? await safe(hr.get(`/vacancies/${vac.id}/pipeline/counts`)) : undefined;
  console.log("vacancy.ubicacion", keys(vac?.ubicacion));
  console.log("vacancy.client", keys(vac?.client));
  console.log("vacancy.usuarios[0]", keys(vac?.usuarios?.[0]));
  console.log("vacancy detail top-level", keys(vac ? await safe(hr.get(`/vacancies/${vac.id}`)) : undefined));
  console.log("pipeline counts", keys(counts), "stage[0]", keys(counts?.pipeline?.stage?.[0]));
  console.log("hired top-level", keys(hiredBody), "item", keys(firstArray(hiredBody)[0]));
  console.log("byChangedStatus top-level", keys(moved));
  console.log("estados de vacantes (valores de estadoActual, no personales)", [...new Set(allVacs.map((v: any) => v.estadoActual))]);
  console.log("listStatus=Activa", keys(await safe(hr.get("/vacancies", { page: 0, pageSize: 10, listStatus: "Activa" }))));

  // 2. Every tool through the MCP layer.
  const server = createServer(ctx, memoryAudit());
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "smoke", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);

  const firstPost = vac ? firstArray(await hr.get("/postulants/", { vacancyId: vac.id, page: 0, pageSize: 10 }))[0] : undefined;
  const monthAgo = addDays(today, -30);
  const calls: [string, Record<string, unknown>][] = [
    ["catalogos", { tipo: "pipelines" }],
    ["buscar_vacantes", { estado: ["Activa"] }],
    ["ver_vacante", { id: vac?.id ?? "x", incluir_estadisticas: true }],
    ["buscar_postulantes", { vacante_id: vac?.id, etapa: "Entrevista" }],
    ["ver_postulante", { id: firstPost?.id ?? "x" }],
    ["leer_cv", { postulante_id: firstPost?.id ?? "x" }],
    ["buscar_por_perfil", { palabras: ["soldador"], desde: monthAgo, hasta: today }],
    ["reporte_contrataciones", { desde: addDays(today, -89), hasta: today }],
    ["reporte_movimientos_vacantes", { desde: addDays(today, -13), hasta: today }],
    ["postulaciones_por_dia", { desde: addDays(today, -6), hasta: today }],
  ];
  for (const [name, args] of calls) {
    const t0 = Date.now();
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as { text: string }[])[0]?.text ?? "";
    const json = r.isError ? undefined : JSON.parse(text);
    console.log(
      name.padEnd(30),
      `${Date.now() - t0}ms`.padStart(8),
      r.isError ? `ERROR: ${text}` : `ok bytes=${text.length} keys=${keys(json)} items=${json.items?.length ?? "-"} completo=${json.completo ?? "-"}`,
    );
  }
  await client.close();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
