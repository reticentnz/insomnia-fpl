export type SortDirection = "asc" | "desc";
export type SortValue = string | number | null | undefined;

export function nextSortDirection(
  currentKey: string | null,
  nextKey: string,
  currentDirection: SortDirection,
): SortDirection {
  return currentKey === nextKey && currentDirection === "asc" ? "desc" : "asc";
}

export function compareSortValues(
  left: SortValue,
  right: SortValue,
  direction: SortDirection,
): number {
  const leftMissing = left == null || (typeof left === "number" && Number.isNaN(left));
  const rightMissing = right == null || (typeof right === "number" && Number.isNaN(right));

  // Empty league data is less useful, so keep it at the bottom for both directions.
  if (leftMissing || rightMissing) {
    if (leftMissing && rightMissing) return 0;
    return leftMissing ? 1 : -1;
  }

  const result = typeof left === "number" && typeof right === "number"
    ? left - right
    : String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: "base" });

  return direction === "asc" ? result : -result;
}
