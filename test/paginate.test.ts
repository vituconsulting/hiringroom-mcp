import { describe, expect, it } from "vitest";
import { UpstreamError } from "../src/errors.js";
import type { HrGetOptions, HrLike, Query } from "../src/hr/client.js";
import { fetchAll, firstArray } from "../src/hr/paginate.js";

function pagedHr(total: number, failPages: number[] = []) {
  const calls: Query[] = [];
  const hr: HrLike = {
    async get<T = any>(_path: string, query: Query = {}, _opts?: HrGetOptions) {
      calls.push(query);
      const page = Number(query.page);
      if (failPages.includes(page)) throw new UpstreamError("boom");
      const size = Number(query.pageSize);
      const start = page * size;
      const n = Math.max(0, Math.min(size, total - start));
      return { total, totalPaginas: Math.ceil(total / size), curriculums: Array.from({ length: n }, (_, i) => ({ id: start + i })) } as T;
    },
    async getBinary() {
      throw new Error("unused");
    },
  };
  return { hr, calls };
}

describe("firstArray", () => {
  it("finds the list in known shapes", () => {
    expect(firstArray([1])).toEqual([1]);
    expect(firstArray({ total: 1, vacantes: [2] })).toEqual([2]);
    expect(firstArray({ x: 1 })).toEqual([]);
    expect(firstArray(null)).toEqual([]);
  });
});

describe("fetchAll", () => {
  it("fetches every page up to maxItems", async () => {
    const { hr, calls } = pagedHr(250);
    const r = await fetchAll(hr, "/postulants/", { vacancyId: "v" }, 1000);
    expect(r.items).toHaveLength(250);
    expect(r).toMatchObject({ total: 250, completo: true, advertencias: [] });
    expect(calls.map((c) => c.page)).toEqual([0, 1, 2]);
    expect(calls[0]).toMatchObject({ vacancyId: "v", pageSize: 100 });
  });

  it("stops at maxItems and flags the partial scan", async () => {
    const { hr, calls } = pagedHr(2500);
    const r = await fetchAll(hr, "/p", {}, 300);
    expect(r.items).toHaveLength(300);
    expect(r.completo).toBe(false);
    expect(r.advertencias[0]).toMatch(/300 de 2500/);
    expect(calls).toHaveLength(3);
  });

  it("tolerates failing pages", async () => {
    const { hr } = pagedHr(250, [1]);
    const r = await fetchAll(hr, "/p", {}, 1000);
    expect(r.items).toHaveLength(150);
    expect(r.completo).toBe(false);
    expect(r.advertencias.join()).toMatch(/página 2/);
  });

  it("stops when the deadline passes", async () => {
    const { hr } = pagedHr(1000);
    let t = 0;
    const r = await fetchAll(hr, "/p", {}, 1000, { deadline: 5, now: () => (t += 10), batch: 2 });
    expect(r.items).toHaveLength(100);
    expect(r.completo).toBe(false);
    expect(r.advertencias.join()).toMatch(/tiempo/);
  });
});
