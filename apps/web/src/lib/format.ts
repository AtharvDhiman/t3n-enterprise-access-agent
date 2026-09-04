/**
 * Display formatting helpers.
 *
 * Timestamps are rendered compactly (`29 Aug, 19:24`) rather than with
 * `toLocaleString()`. The long form pushes tables past their container and
 * introduces a horizontal scrollbar for information nobody reads to the second.
 * The full ISO value is rendered by `formatExact` in the expanded audit detail,
 * where the exact instant is what matters — this docblock used to promise that
 * and no component actually showed it.
 */

export function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const month = d.toLocaleString(undefined, { month: "short" });
  // The year is shown whenever it is not the current one. Without it a record
  // from a previous year rendered identically to one from this year, which in
  // an audit table is not a cosmetic problem: two decisions a year apart looked
  // like the same day.
  const year = d.getFullYear() === new Date().getFullYear() ? "" : ` ${d.getFullYear()}`;
  return `${d.getDate()} ${month}${year}, ${time}`;
}

/**
 * The exact instant, unambiguous and copyable.
 *
 * Shown in the expanded audit detail. The compact form above is local time with
 * no offset, which is fine for scanning a table and useless for evidence — an
 * auditor correlating this journal with another system needs the value the file
 * actually stores.
 */
export function formatExact(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString();
}
