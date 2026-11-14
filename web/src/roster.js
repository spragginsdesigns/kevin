// Employee of the Month: the roster's order, how many get_roster pages a refresh reads, and the
// calendar month (UTC) the contract counts in. Pure functions over plain chain data.
export const ROSTER_PAGE = 25;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAY = 86_400_000;
const num = (x) => Number(x ?? 0) || 0;
const bigOf = (x) => {
  try {
    return BigInt(x ?? 0);
  } catch {
    return 0n;
  }
};

// YYYYMM in UTC for a millisecond timestamp, with the same integer civil-from-days arithmetic
// (Howard Hinnant) the contract uses, so the page and the chain agree on month boundaries.
export function monthOf(ms) {
  const z = Math.floor(Number(ms) / DAY) + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const m = mp < 10 ? mp + 3 : mp - 9;
  const y = yoe + era * 400 + (m <= 2 ? 1 : 0);
  return y * 100 + m;
}

// "November 2026" for 202611.
export const monthName = (yyyymm) => `${MONTHS[(num(yyyymm) % 100) - 1]} ${Math.floor(num(yyyymm) / 100)}`;

// month_on_time desc, then streak desc, then month_missed asc, then first_on_call_ms asc.
// Ties after that keep roster order (the order desks first went on call).
export function orderRoster(entries) {
  return (entries || [])
    .map((e, i) => ({ e, i }))
    .sort((a, b) => {
      const x = a.e.desk || {};
      const y = b.e.desk || {};
      const firstX = bigOf(x.first_on_call_ms);
      const firstY = bigOf(y.first_on_call_ms);
      return (
        num(y.month_on_time) - num(x.month_on_time) ||
        num(y.streak) - num(x.streak) ||
        num(x.month_missed) - num(y.month_missed) ||
        (firstX < firstY ? -1 : firstX > firstY ? 1 : 0) ||
        a.i - b.i
      );
    })
    .map(({ e }) => e);
}

// The plaque goes to the first row only when that desk answered something on time this month.
export const plaqueFor = (ordered) => (ordered?.[0] && num(ordered[0].desk?.month_on_time) > 0 ? ordered[0] : null);

// get_roster calls one refresh needs: none for an empty roster, one for up to 25 desks.
export const rosterPages = (count, page = ROSTER_PAGE) => Math.ceil(Math.max(0, num(count)) / page);

// Read the whole roster. With a known count (get_stats.roster) the pages are read in parallel and
// never one more than needed; without one, page until a short page comes back.
// get_roster projects every desk's pending burns, which costs more view gas the further behind a desk
// is. A page that fails is read again in halves, so one neglected desk cannot blank the whole board; a
// page of one that still fails is rethrown (the caller keeps the last roster on screen).
export async function readRosterPage(getRoster, from, count) {
  try {
    return (await getRoster(from, count)) || [];
  } catch (e) {
    if (count <= 1) throw e;
    const half = Math.ceil(count / 2);
    const [a, b] = await Promise.all([readRosterPage(getRoster, from, half), readRosterPage(getRoster, from + half, count - half)]);
    return [...a, ...b];
  }
}

export async function readRoster(getRoster, count, page = ROSTER_PAGE) {
  if (count != null && Number.isFinite(Number(count))) {
    const total = Math.max(0, Number(count));
    const pages = rosterPages(total, page);
    const lists = await Promise.all(Array.from({ length: pages }, (_, i) => readRosterPage(getRoster, i * page, Math.min(page, total - i * page))));
    return lists.flatMap((l) => l || []);
  }
  const out = [];
  for (let from = 0; ; from += page) {
    const list = (await getRoster(from, page)) || [];
    out.push(...list);
    if (list.length < page) return out;
  }
}
