import assert from 'node:assert/strict';
import test from 'node:test';
import { HOLDERS } from './calendar.mjs';
import { DAY_MS, dayNumber, deadlineMs, loadSnapshot } from './kev.mjs';
import { applyMiss } from './model.mjs';
import { simulate } from './simulate.mjs';

const entry = (cveID, dateAdded, dueDate, ransomware = false) => ({
  cveID, vendorProject: 'V', product: 'P', vulnerabilityName: 'n', dateAdded, dueDate,
  knownRansomwareCampaignUse: ransomware ? 'Known' : 'Unknown', shortDescription: '', requiredAction: '',
});

test('hand-checked two-ticket catalog', () => {
  // 2026-01-02 is a Friday; ticket A is due Saturday. 2026-01-05 is a Monday; ticket B (ransomware) is due
  // 2026-01-26. Second Tuesday of January 2026 is the 13th; the next quarter start after Jan 1 is Apr 1.
  const snap = {
    catalogVersion: 't', sourceSha256: 'x', dateReleased: '2026-01-31T00:00:00Z',
    vulnerabilities: [entry('CVE-2026-0001', '2026-01-02', '2026-01-03'), entry('CVE-2026-0002', '2026-01-05', '2026-01-26', true)],
  };
  const r = simulate(snap);
  const by = Object.fromEntries(r.holders.map((h) => [h.id, h]));
  const expect = {
    on_call: [2, 0, 0, 10_000],
    nine_to_five: [1, 1, 0, 9_900],
    weekly: [1, 1, 0, 9_900],
    patch_tuesday: [1, 1, 0, 9_900],
    quarterly: [0, 2, 1, 9_405],
    ghost: [0, 2, 1, 9_405],
  };
  for (const [id, [answered, missed, missedRansomware, keptBps]] of Object.entries(expect)) {
    assert.deepEqual([by[id].answered, by[id].missed, by[id].missedRansomware, by[id].keptBps], [answered, missed, missedRansomware, keptBps], id);
  }
  assert.equal(r.tickets, 2);
  assert.equal(r.from, '2026-01-02');
  assert.equal(r.to, '2026-01-31');
  assert.deepEqual(by.ghost.series.at(-1), { date: '2026-01-31', keptBps: 9_405 });
});

test('a ticket still inside its window at the snapshot instant is pending, not missed', () => {
  const snap = {
    catalogVersion: 't', sourceSha256: 'x', dateReleased: '2026-01-05T20:00:00Z',
    vulnerabilities: [entry('CVE-2026-0003', '2026-01-05', '2026-01-05')],
  };
  const ghost = simulate(snap).holders.find((h) => h.id === 'ghost');
  assert.deepEqual([ghost.missed, ghost.pending, ghost.keptBps], [0, 1, 10_000]);
});

// An independent replay that does not use the Ledger: for each ticket, ask whether any active day inside
// its window lets the holder answer, then apply the misses in expiry order (deadline, then opening order).
function directReplay(snap) {
  const cutoff = Date.parse(snap.dateReleased);
  const sorted = snap.vulnerabilities.map((e, i) => ({ e, i })).sort((a, b) => (a.e.dateAdded < b.e.dateAdded ? -1 : a.e.dateAdded > b.e.dateAdded ? 1 : a.i - b.i));
  const bag = 10_000n * 10n ** 18n;
  return HOLDERS.map((h) => {
    let answered = 0;
    const misses = [];
    sorted.forEach(({ e }, order) => {
      const added = dayNumber(e.dateAdded);
      const due = dayNumber(e.dueDate);
      let ok = false;
      for (let day = added; day <= due && !ok; day++) ok = day * DAY_MS + 12 * 3_600_000 <= cutoff && h.canAnswer(day, added);
      if (ok) answered += 1;
      else if (deadlineMs(e.dueDate) <= cutoff) misses.push({ at: deadlineMs(e.dueDate), order, bps: e.knownRansomwareCampaignUse === 'Known' ? 500 : 100 });
    });
    misses.sort((a, b) => a.at - b.at || a.order - b.order);
    let balance = bag;
    for (const m of misses) balance = applyMiss(balance, m.bps).balance;
    return { id: h.id, answered, missed: misses.length, keptBps: Number((balance * 10_000n) / bag) };
  });
}

test('the real snapshot: Ledger replay agrees with an independent direct replay', async () => {
  const snap = await loadSnapshot();
  const r = simulate(snap);
  const direct = directReplay(snap);
  assert.deepEqual(r.holders.map(({ id, answered, missed, keptBps }) => ({ id, answered, missed, keptBps })), direct);
  assert.equal(r.tickets, snap.vulnerabilities.length);
  assert.equal(r.facts.firstDayEntries, snap.vulnerabilities.filter((e) => e.dateAdded === '2021-11-03').length);
  assert.equal(r.from, '2021-11-03');
});

test('deterministic: two runs serialize byte-identically', async () => {
  const snap = await loadSnapshot();
  assert.equal(JSON.stringify(simulate(snap)), JSON.stringify(simulate(structuredClone(snap))));
});

test('report shape matches what the web app reads', async () => {
  const r = simulate(await loadSnapshot());
  for (const k of ['catalogVersion', 'sourceSha256', 'from', 'to', 'tickets', 'missBps', 'ransomMissBps', 'holders']) assert.ok(k in r, k);
  for (const h of r.holders) {
    for (const k of ['id', 'label', 'answered', 'missed', 'missedRansomware', 'keptBps', 'series']) assert.ok(k in h, `${h.id}.${k}`);
    assert.equal(h.series[0].date, r.from);
    assert.equal(h.series.at(-1).date, r.to);
    assert.ok(h.series.every((p, i) => i === 0 || p.date > h.series[i - 1].date));
    assert.ok(h.series.every((p, i) => i === 0 || p.keptBps <= h.series[i - 1].keptBps), 'a committed stake only shrinks');
  }
});
