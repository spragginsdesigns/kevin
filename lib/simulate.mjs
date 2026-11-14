// Replays the KEV catalog through the settlement model for each holder calendar. Every holder is an ON-CALL desk:
// on the first day it claims the starter bag, commits all of it with go_on_call and never clocks out, so every
// miss burns from its committed stake (the free balance is zero and never burns). Pure and deterministic: the
// same snapshot always yields the same report, so data/sim-report.json can be diffed in review.

import { HOLDERS, isMonthStart } from './calendar.mjs';
import { DAY_MS, dayNumber, dayString, toReport } from './kev.mjs';
import { Ledger } from './model.mjs';

const KEVIN = 10n ** 18n;
// Parameters from the deployment plan, so the replay answers "what would the deployed coin have done".
export const SIM_DEFAULTS = Object.freeze({
  missBps: 100,
  ransomMissBps: 500,
  minWindowMs: 3_600_000,
  deployedMaxOpen: 128,
  initialSupply: 1_000_000_000n * KEVIN,
  minCommit: 1_000n * KEVIN,
  minShiftMs: 604_800_000n, // the replayed holders never clock out, so this changes no number
  // The starter bag, committed in full on day one.
  bag: 10_000n * KEVIN,
});
// A holder that is active on a day acts at midday UTC: after that day's tickets open at 00:00, before
// that day's deadlines at 23:59:59.
const ACT_OFFSET_MS = 12 * 3_600_000;
const END_OF_DAY_MS = DAY_MS - 1000;
const WINDOW_BUCKETS = [[1, 3], [4, 7], [8, 14], [15, 21], [22, 30], [31, 90], [91, 180], [181, Infinity]];

function quantile(sorted, q) {
  return sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))];
}

/** Catalog facts the sim prints; every number here is computed from the snapshot. */
export function catalogFacts(snapshot) {
  const v = snapshot.vulnerabilities;
  const added = v.map((e) => e.dateAdded).sort();
  const first = added[0];
  const windows = v.map((e) => dayNumber(e.dueDate) - dayNumber(e.dateAdded)).sort((a, b) => a - b);
  const counts = new Map();
  for (const w of windows) counts.set(w, (counts.get(w) ?? 0) + 1);
  const [modeDays, modeCount] = [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
  const ransomware = v.filter((e) => e.knownRansomwareCampaignUse === 'Known').length;
  return {
    entries: v.length,
    catalogVersion: snapshot.catalogVersion,
    dateReleased: snapshot.dateReleased,
    firstDateAdded: first,
    lastDateAdded: added[added.length - 1],
    lastDueDate: v.map((e) => e.dueDate).sort().at(-1),
    firstDayEntries: added.filter((d) => d === first).length,
    ransomware,
    ransomwareBps: Math.round((ransomware * 10_000) / v.length),
    windowDays: {
      min: windows[0],
      p10: quantile(windows, 0.1),
      median: quantile(windows, 0.5),
      p90: quantile(windows, 0.9),
      max: windows.at(-1),
      mode: modeDays,
      modeCount,
      buckets: WINDOW_BUCKETS.map(([lo, hi]) => ({
        label: hi === Infinity ? `${lo}+` : `${lo}-${hi}`,
        count: windows.filter((w) => w >= lo && w <= hi).length,
      })),
    },
  };
}

/**
 * Run the replay. Returns the report object written to data/sim-report.json.
 * The evaluation instant is the snapshot's dateReleased: tickets whose deadline is later are still open.
 */
export function simulate(snapshot, opts = {}) {
  const p = { ...SIM_DEFAULTS, ...opts };
  const cutoff = Date.parse(snapshot.dateReleased);
  if (!Number.isFinite(cutoff)) throw new Error('snapshot.dateReleased is not a timestamp');
  // Opening order within a day follows the snapshot order, which is fixed for a given snapshot.
  const entries = snapshot.vulnerabilities
    .map((e, i) => ({ e, i }))
    .sort((a, b) => (a.e.dateAdded < b.e.dateAdded ? -1 : a.e.dateAdded > b.e.dateAdded ? 1 : a.i - b.i))
    .map(({ e }) => e);
  const byDay = new Map();
  for (const e of entries) {
    const d = dayNumber(e.dateAdded);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(e);
  }
  const firstDay = dayNumber(entries[0].dateAdded);
  const lastDay = Math.floor(cutoff / DAY_MS);

  // max_open is not enforced here (the replay covers the whole catalog); the peak is reported instead.
  const ledger = new Ledger({
    missBps: p.missBps,
    ransomMissBps: p.ransomMissBps,
    minWindowMs: p.minWindowMs,
    starterBag: p.bag,
    initialSupply: p.initialSupply,
    minCommit: p.minCommit,
    minShiftMs: p.minShiftMs,
  });
  const t0 = firstDay * DAY_MS;
  for (const h of HOLDERS) {
    ledger.register(h.id, t0);
    ledger.claimStarter(h.id, t0);
    ledger.goOnCall(h.id, p.bag, t0);
  }
  // The share of the committed stake that is left.
  const kept = (id, at) => Number((ledger.desk(id, at).committed * 10_000n) / p.bag);
  const series = new Map(HOLDERS.map((h) => [h.id, [{ date: dayString(firstDay), keptBps: 10_000 }]]));
  const refused = [];
  let peakOpen = { count: 0, date: null };
  let daysOverMaxOpen = 0;

  for (let day = firstDay; day <= lastDay; day++) {
    const dayStart = day * DAY_MS;
    if (day !== firstDay && isMonthStart(day)) {
      for (const h of HOLDERS) series.get(h.id).push({ date: dayString(day), keptBps: kept(h.id, dayStart) });
    }
    for (const e of byDay.get(day) ?? []) {
      try {
        ledger.open(toReport(e), dayStart);
      } catch (err) {
        refused.push({ cveID: e.cveID, reason: err.message });
      }
    }
    const openNow = ledger.openTickets(dayStart).length;
    if (openNow > peakOpen.count) peakOpen = { count: openNow, date: dayString(day) };
    if (openNow > p.deployedMaxOpen) daysOverMaxOpen += 1;

    const actAt = dayStart + ACT_OFFSET_MS;
    if (actAt <= cutoff) {
      for (const h of HOLDERS) {
        for (const t of ledger.openTickets(actAt)) {
          if (ledger.statement(h.id, t.id)) continue;
          if (h.canAnswer(day, dayNumber(t.dateAdded))) ledger.close(h.id, t.id, 'fixed', actAt);
        }
      }
    }
    const endAt = Math.min(dayStart + END_OF_DAY_MS, cutoff);
    ledger.poke(endAt);
    for (const h of HOLDERS) while (ledger.settle(h.id, 200, endAt).remaining > 0);
  }

  const to = dayString(lastDay);
  const holders = HOLDERS.map((h) => {
    const desk = ledger.desk(h.id, cutoff);
    let missedRansomware = 0;
    let pending = 0;
    for (const t of ledger.tickets) {
      const answered = Boolean(ledger.statement(h.id, t.id));
      if (ledger.ticketState(t.id, cutoff) === 'expired') {
        if (!answered && t.ransomware) missedRansomware += 1;
      } else if (!answered) {
        pending += 1;
      }
    }
    if (desk.onTime + desk.missed + pending !== ledger.tickets.length) {
      throw new Error(`accounting mismatch for ${h.id}`);
    }
    if (!desk.onCall || desk.balance !== 0n) throw new Error(`${h.id} left the on-call program`);
    const points = series.get(h.id);
    if (points.at(-1).date !== to) points.push({ date: to, keptBps: kept(h.id, cutoff) });
    return {
      id: h.id,
      label: h.label,
      answered: desk.onTime,
      missed: desk.missed,
      missedRansomware,
      pending,
      keptBps: kept(h.id, cutoff),
      // ft_balance_of: free (zero here) plus the committed stake that is left.
      balance: ledger.balanceOf(h.id, cutoff).toString(),
      series: points,
    };
  });
  const burnedByHolders = holders.reduce((s, h) => s + (p.bag - BigInt(h.balance)), 0n);
  if (ledger.initialSupply - ledger.totalSupply !== burnedByHolders) throw new Error('supply invariant broken');

  const facts = catalogFacts(snapshot);
  return {
    catalogVersion: snapshot.catalogVersion,
    sourceSha256: snapshot.sourceSha256,
    from: dayString(firstDay),
    to,
    evaluatedAt: new Date(cutoff).toISOString(),
    tickets: ledger.tickets.length,
    missBps: p.missBps,
    ransomMissBps: p.ransomMissBps,
    bag: p.bag.toString(),
    holders,
    facts: {
      ...facts,
      refused: refused.length,
      refusedReasons: [...new Set(refused.map((r) => r.reason))].sort(),
      peakOpen: peakOpen.count,
      peakOpenDate: peakOpen.date,
      deployedMaxOpen: p.deployedMaxOpen,
      daysOverDeployedMaxOpen: daysOverMaxOpen,
      openAtEvaluation: ledger.openTickets(cutoff).length,
      ransomwareFlagNote: 'knownRansomwareCampaignUse is the value in the snapshot; CISA can change it after an entry is added.',
    },
  };
}
