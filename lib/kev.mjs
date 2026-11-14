// CISA Known Exploited Vulnerabilities (KEV) catalog: loading, fetching, and turning an entry into the
// contract's TicketReport. Browser-safe except loadSnapshot(), which imports node:fs lazily so the web build
// can import this module for toReport() and the date helpers.

export const CISA_FEED_URL = 'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json';
export const MIRROR_FEED_URL =
  'https://raw.githubusercontent.com/cisagov/kev-data/develop/known_exploited_vulnerabilities.json';

// cisa.gov sits behind a CDN that refuses requests without a browser-like User-Agent.
const BROWSER_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';

export const DAY_MS = 86_400_000;
// Contract limits from the ABI; toReport() enforces them so a reporter never pays gas for a panic.
export const MAX_FIELD_BYTES = 80;
export const MAX_CVE_LENGTH = 24;
const CVE_RE = /^CVE-\d{4}-\d+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Days since 1970-01-01 for a YYYY-MM-DD string, in UTC. Throws on anything that is not a real date. */
export function dayNumber(date) {
  if (typeof date !== 'string' || !DATE_RE.test(date)) throw new Error(`bad date: ${date}`);
  const [y, m, d] = date.split('-').map(Number);
  const ms = Date.UTC(y, m - 1, d);
  // Date.UTC silently rolls 2026-02-30 into March; round-tripping catches that.
  if (new Date(ms).toISOString().slice(0, 10) !== date) throw new Error(`bad date: ${date}`);
  return ms / DAY_MS;
}

/** YYYY-MM-DD for a UTC day number. */
export function dayString(day) {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

/** A ticket opens at 00:00:00.000 UTC on the day CISA added the entry. */
export function openMs(dateAdded) {
  return dayNumber(dateAdded) * DAY_MS;
}

/** A ticket's deadline is CISA's dueDate at 23:59:59.000 UTC. */
export function deadlineMs(dueDate) {
  return dayNumber(dueDate) * DAY_MS + DAY_MS - 1000;
}

const encoder = new TextEncoder();

/** Truncate to at most maxBytes of UTF-8 without splitting a code point (the contract stores bytes). */
export function truncateUtf8(text, maxBytes = MAX_FIELD_BYTES) {
  const s = String(text ?? '');
  if (encoder.encode(s).length <= maxBytes) return s;
  let out = '';
  let used = 0;
  for (const ch of s) {
    const n = encoder.encode(ch).length;
    if (used + n > maxBytes) break;
    out += ch;
    used += n;
  }
  return out;
}

export function isRansomware(entry) {
  return entry.knownRansomwareCampaignUse === 'Known';
}

/**
 * The contract's TicketReport for one KEV entry. Every reporter must derive byte-identical reports (the
 * contract identifies a report by the sha256 of its borsh bytes), so this is a pure function of the entry.
 * Throws with the contract's own panic wording when the entry could never be accepted.
 */
export function toReport(entry) {
  const cve = String(entry.cveID ?? '');
  if (!CVE_RE.test(cve) || cve.length > MAX_CVE_LENGTH) throw new Error(`bad cve id: ${cve}`);
  dayNumber(entry.dateAdded);
  dayNumber(entry.dueDate);
  return {
    cve_id: cve,
    vendor: truncateUtf8(entry.vendorProject),
    product: truncateUtf8(entry.product),
    date_added: entry.dateAdded,
    due_date: entry.dueDate,
    ransomware: isRansomware(entry),
    deadline_ms: String(deadlineMs(entry.dueDate)),
  };
}

/** Throws unless the object looks like a KEV catalog; returns it. */
export function checkCatalog(catalog) {
  if (!catalog || !Array.isArray(catalog.vulnerabilities)) throw new Error('not a KEV catalog: no vulnerabilities[]');
  for (const e of catalog.vulnerabilities) {
    if (!e || typeof e.cveID !== 'string' || typeof e.dateAdded !== 'string' || typeof e.dueDate !== 'string') {
      throw new Error(`not a KEV catalog: malformed entry ${JSON.stringify(e)?.slice(0, 120)}`);
    }
  }
  return catalog;
}

/**
 * Fetch the live catalog, CISA first and the cisagov/kev-data mirror second.
 * Returns { catalog, url }. Throws an Error listing every source's failure if none worked.
 */
export async function fetchCatalog({ fetchImpl = globalThis.fetch, urls = [CISA_FEED_URL, MIRROR_FEED_URL], timeoutMs = 20_000 } = {}) {
  const failures = [];
  for (const url of urls) {
    try {
      const res = await fetchImpl(url, {
        headers: { 'user-agent': BROWSER_UA, accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { catalog: checkCatalog(await res.json()), url };
    } catch (err) {
      failures.push(`${url}: ${err.message}`);
    }
  }
  throw new Error(`KEV catalog unreachable (${failures.join('; ')})`);
}

/** Load the committed snapshot (Node only). Defaults to data/kev-snapshot.json next to this repo's lib/. */
export async function loadSnapshot(path) {
  const { readFile } = await import('node:fs/promises');
  const target = path ?? new URL('../data/kev-snapshot.json', import.meta.url);
  return checkCatalog(JSON.parse(await readFile(target, 'utf8')));
}

/**
 * The open queue as the contract would show it if every catalog entry still inside its window had been
 * reported: Ticket JSON per the ABI, ids by deadline. Only for dry runs before the contract is reachable.
 */
export function standInTickets(entries, { nowMs, missBps = 100, ransomMissBps = 500 }) {
  return entries
    .filter((e) => deadlineMs(e.dueDate) > nowMs)
    .map((e) => toReport(e))
    .sort((a, b) => Number(a.deadline_ms) - Number(b.deadline_ms) || (a.cve_id < b.cve_id ? -1 : 1))
    .map((r, id) => ({
      id,
      ...r,
      opened_at_ms: String(openMs(r.date_added)),
      burn_bps: r.ransomware ? ransomMissBps : missBps,
      state: 'open',
      closes: 0,
      not_affected: 0,
      fixed: 0,
      mitigated: 0,
      missed: 0,
      burned: '0',
    }));
}
