// Which KEV entries a reporter should send. Pure, so it is tested without a network or a chain.

import { toReport } from './kev.mjs';

/**
 * Entries worth asking the chain about: valid for the contract and with a deadline far enough out that the
 * contract's "window too short" check (re-run on every confirmation) will still pass. The margin covers
 * the time between this check and the last reporter's confirmation. Sorted soonest deadline first, so
 * the most urgent tickets get the open slots when max_open is tight.
 */
export function candidates(entries, { nowMs, minWindowMs, marginMs = 600_000 }) {
  const out = [];
  const skipped = [];
  const seen = new Set();
  for (const entry of entries) {
    let report;
    try {
      report = toReport(entry);
    } catch (err) {
      skipped.push({ cve: entry?.cveID, reason: err.message });
      continue;
    }
    if (seen.has(report.cve_id)) {
      skipped.push({ cve: report.cve_id, reason: 'duplicate in catalog' });
      continue;
    }
    seen.add(report.cve_id);
    if (Number(report.deadline_ms) < nowMs + minWindowMs + marginMs) continue;
    out.push(report);
  }
  out.sort((a, b) => Number(a.deadline_ms) - Number(b.deadline_ms) || (a.cve_id < b.cve_id ? -1 : 1));
  return { reports: out, skipped };
}

/**
 * Final send list: drop what is already on chain and stop at the free open slots. `onChain` is a Set of
 * CVE ids that get_ticket_by_cve returned a ticket for; `freeSlots` is max_open minus tickets still open.
 */
export function planReports(reports, { onChain, freeSlots }) {
  const send = [];
  const held = [];
  for (const r of reports) {
    if (onChain.has(r.cve_id)) continue;
    if (send.length >= freeSlots) held.push(r);
    else send.push(r);
  }
  return { send, held };
}

/** Panics that mean "nothing to do" for this reporter, so a second run is a no-op rather than a failure. */
export function isBenignReportError(message) {
  return /already confirmed|ticket exists/.test(String(message));
}
