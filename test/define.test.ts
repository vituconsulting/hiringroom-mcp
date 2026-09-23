import { describe, expect, it } from "vitest";
import { AuthError, HrValidationError, InputError, NotFoundError, UpstreamError } from "../src/errors.js";
import { errorMessage, orNotFound, unwrap } from "../src/tools/define.js";
import { connect, FakeHr } from "./helpers/harness.js";

describe("errorMessage", () => {
  it("maps typed errors to Spanish messages", () => {
    expect(errorMessage(new InputError("x mal"))).toBe("x mal");
    expect(errorMessage(new AuthError("t"))).toBe("credenciales de HiringRoom inválidas, revisar .env");
    expect(errorMessage(new NotFoundError("/v/1", "no existe vacante `1`"))).toBe("no existe vacante `1`");
    expect(errorMessage(new HrValidationError(["a", "b"]))).toBe("HiringRoom rechazó el pedido: a; b");
    expect(errorMessage(new UpstreamError("t"))).toBe("HiringRoom no responde, reintentar más tarde");
    expect(errorMessage(new Error("secret stack"))).toBe("error interno del MCP (ver logs)");
  });

  it("orNotFound rewrites the message; unwrap finds the payload", async () => {
    await expect(orNotFound(Promise.reject(new NotFoundError("/x")), "vacante", "9")).rejects.toThrow("no existe vacante `9`");
    expect(unwrap({ postulant: { id: 1 } }, "postulant")).toEqual({ id: 1 });
    expect(unwrap({ id: 2 }, "postulant")).toEqual({ id: 2 });
  });
});

describe("registerTool", () => {
  it("audits ok and error calls; auth failure does not crash the server", async () => {
    const t = await connect(new FakeHr({ "/pipeline/": () => new AuthError("bad"), "/account/areas": [{ id: 1 }] }));
    const bad = await t.call("catalogos", { tipo: "pipelines" });
    expect(bad).toMatchObject({ isError: true, text: "credenciales de HiringRoom inválidas, revisar .env" });
    const ok = await t.call("catalogos", { tipo: "areas" });
    expect(ok.isError).toBe(false);
    expect(t.audit.entries.map((e) => e.resultado)).toEqual(["error", "ok"]);
    expect(t.audit.entries[1]).toMatchObject({ tool: "catalogos", n_items: 1 });
  });

  it("trims oversized responses", async () => {
    const big = Array.from({ length: 500 }, (_, i) => ({ id: i, nombre: "x".repeat(100) }));
    const t = await connect(new FakeHr({ "/account/areas": big }), { limits: { responseMaxBytes: 5000 } });
    const r = await t.call("catalogos", { tipo: "areas" });
    expect(r.json.recortado).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(5000);
  });

  it("strips genero and fotoPerfil recursively from any tool result, as a last line of defence", async () => {
    const t = await connect(
      new FakeHr({ "/account/areas": [{ id: 1, nombre: "Producción", meta: { genero: "Femenino", fotoPerfil: "https://x/foto.jpg", nombre: "ok" } }] }),
    );
    const r = await t.call("catalogos", { tipo: "areas" });
    expect(r.text).not.toContain("Femenino");
    expect(r.text).not.toContain("foto.jpg");
    expect(r.json.items[0].meta).toEqual({ nombre: "ok" });
  });
});
