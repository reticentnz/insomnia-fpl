import { describe, expect, it } from "vitest";
import { compareSortValues, nextSortDirection } from "./table-sorting";

describe("league table sorting", () => {
  it("starts a new column ascending and toggles the active column", () => {
    expect(nextSortDirection(null, "rank", "asc")).toBe("asc");
    expect(nextSortDirection("rank", "rank", "asc")).toBe("desc");
    expect(nextSortDirection("rank", "total", "desc")).toBe("asc");
  });

  it("sorts numeric and text values in either direction", () => {
    expect([10, 2, 7].sort((a, b) => compareSortValues(a, b, "asc"))).toEqual([2, 7, 10]);
    expect(["Zulu", "alpha", "Bravo"].sort((a, b) => compareSortValues(a, b, "desc"))).toEqual(["Zulu", "Bravo", "alpha"]);
  });

  it("keeps missing values at the bottom", () => {
    expect([null, 3, 8].sort((a, b) => compareSortValues(a, b, "desc"))).toEqual([8, 3, null]);
  });
});
