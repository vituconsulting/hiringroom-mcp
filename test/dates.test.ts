import { describe, expect, it } from "vitest";
import { InputError } from "../src/errors.js";
import {
  addDays, assertIso, assertRange, daysInclusive, eachDay, epochEnd, epochStart, normalizeHrDate, splitWindows, toDmy,
} from "../src/hr/dates.js";

describe("dates", () => {
  it("validates ISO dates, including impossible days", () => {
    expect(() => assertIso("2026-09-23")).not.toThrow();
    expect(() => assertIso("23-09-2026")).toThrow(InputError);
    expect(() => assertIso("2026-02-30")).toThrow(InputError);
  });

  it("converts to Buenos Aires epoch bounds", () => {
    // 2026-09-23T00:00:00-03:00 == 2026-09-23T03:00:00Z
    expect(epochStart("2026-09-23")).toBe(Date.UTC(2026, 8, 23, 3) / 1000);
    expect(epochEnd("2026-09-23")).toBe(epochStart("2026-09-23") + 86399);
  });

  it("formats DD-MM-YYYY and does day math", () => {
    expect(toDmy("2026-09-03")).toBe("03-09-2026");
    expect(addDays("2026-02-27", 2)).toBe("2026-03-01");
    expect(daysInclusive("2026-09-01", "2026-09-30")).toBe(30);
  });

  it("checks ranges", () => {
    expect(() => assertRange("2026-09-10", "2026-09-01")).toThrow(/posterior/);
    expect(() => assertRange("2026-09-01", "2026-10-01", 30)).toThrow(/30 días/);
    expect(() => assertRange("2026-09-01", "2026-09-30", 30)).not.toThrow();
  });

  it("splits ranges into contiguous windows of at most maxDays", () => {
    expect(splitWindows("2026-07-01", "2026-08-15", 30)).toEqual([
      { desde: "2026-07-01", hasta: "2026-07-30" },
      { desde: "2026-07-31", hasta: "2026-08-15" },
    ]);
    expect(splitWindows("2026-09-01", "2026-09-01", 7)).toEqual([{ desde: "2026-09-01", hasta: "2026-09-01" }]);
  });

  it("lists each day", () => {
    expect(eachDay("2026-09-29", "2026-10-01")).toEqual(["2026-09-29", "2026-09-30", "2026-10-01"]);
  });

  it("normalizes HiringRoom dates", () => {
    expect(normalizeHrDate("23-09-2026")).toBe("2026-09-23");
    expect(normalizeHrDate("23/09/2026")).toBe("2026-09-23");
    expect(normalizeHrDate("2026-09-23T10:00:00Z")).toBe("2026-09-23");
    expect(normalizeHrDate(null)).toBeUndefined();
    expect(normalizeHrDate("")).toBeUndefined();
  });
});
