// Employee of the Month ordering. Pure and dependency-free so the web app can keep an identical copy.
//
// Input: RosterEntry objects as get_roster returns them, { account_id, desk }, where the desk's counters are
// numbers (u32) and first_on_call_ms is a decimal string (U64). Order: month_on_time desc, then streak desc,
// then month_missed asc, then first_on_call_ms asc (earlier first). Entries equal on all four keep their
// roster order.

const big = (v) => BigInt(String(v ?? 0));

/** Compare two roster entries by the Employee of the Month rule. */
export function compareRosterEntries(a, b) {
  const x = a.desk ?? {};
  const y = b.desk ?? {};
  return (
    (y.month_on_time ?? 0) - (x.month_on_time ?? 0) ||
    (y.streak ?? 0) - (x.streak ?? 0) ||
    (x.month_missed ?? 0) - (y.month_missed ?? 0) ||
    (big(x.first_on_call_ms) < big(y.first_on_call_ms) ? -1 : big(x.first_on_call_ms) > big(y.first_on_call_ms) ? 1 : 0)
  );
}

/** A new array of the entries in Employee of the Month order. The input is not changed. */
export function rankRoster(entries) {
  return [...(entries ?? [])].sort(compareRosterEntries);
}
