/**
 * Display formatting helpers.
 *
 * Timestamps are rendered compactly (`29 Aug, 19:24`) rather than with
 * `toLocaleString()`. The long form pushes tables past their container and
 * introduces a horizontal scrollbar for information nobody reads to the second;
 * the full ISO value is still available in the expanded audit detail.
 */

export function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.getDate()} ${d.toLocaleString(undefined, { month: "short" })}, ${String(
    d.getHours(),
  ).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
