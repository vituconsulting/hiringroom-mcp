import { describe, expect, it } from "vitest";
import { pipelinesRaw } from "./fixtures.js";
import { connect, FakeHr } from "./helpers/harness.js";

describe("catalogos", () => {
  it("lists pipelines with stages", async () => {
    const t = await connect(new FakeHr({ "/pipeline/": pipelinesRaw() }));
    const r = await t.call("catalogos", { tipo: "pipelines" });
    expect(r.isError).toBe(false);
    expect(r.json.items[1]).toMatchObject({ id: "p2", nombre: "Pipeline vigente" });
    expect(r.json.items[1].etapas).toContainEqual({ id: 7, nombre: "PRESENTADO" });
  });

  it("lists clients from the list key and caches them", async () => {
    const hr = new FakeHr({ "/account/customers": { clientes: [{ id: "c1", nombre: "Operadora Sur" }] } });
    const t = await connect(hr);
    const r = await t.call("catalogos", { tipo: "clientes" });
    expect(r.json).toEqual({ tipo: "clientes", total: 1, items: [{ id: "c1", nombre: "Operadora Sur" }] });
    await t.call("catalogos", { tipo: "clientes" });
    expect(hr.calls).toHaveLength(1);
  });

  it("rejects unknown types via schema", async () => {
    const t = await connect(new FakeHr({}));
    const r = await t.call("catalogos", { tipo: "otra" });
    expect(r.isError).toBe(true);
  });

  it("does not turn an empty array payload into a phantom item", async () => {
    const t = await connect(new FakeHr({ "/account/areas": [] }));
    const r = await t.call("catalogos", { tipo: "areas" });
    expect(r.isError).toBe(false);
    expect(r.json.total).toBe(0);
    expect(r.json.items ?? []).toEqual([]);
  });

  it("does not turn an empty list-key payload into a phantom item", async () => {
    const t = await connect(new FakeHr({ "/account/customers": { clientes: [] } }));
    const r = await t.call("catalogos", { tipo: "clientes" });
    expect(r.isError).toBe(false);
    expect(r.json.total).toBe(0);
    expect(r.json.items ?? []).toEqual([]);
  });

  it("still wraps a plain object payload with no array as a single item", async () => {
    const t = await connect(new FakeHr({ "/account/areas": { id: 1, nombre: "X" } }));
    const r = await t.call("catalogos", { tipo: "areas" });
    expect(r.isError).toBe(false);
    expect(r.json).toEqual({ tipo: "areas", total: 1, items: [{ id: 1, nombre: "X" }] });
  });
});
