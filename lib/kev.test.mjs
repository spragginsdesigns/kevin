import assert from 'node:assert/strict';
import test from 'node:test';
import { CISA_FEED_URL, MIRROR_FEED_URL, dayNumber, deadlineMs, fetchCatalog, loadSnapshot, openMs, standInTickets, toReport, truncateUtf8 } from './kev.mjs';

const bytes = (s) => new TextEncoder().encode(s).length;

test('deadline is dueDate 23:59:59.000 UTC; a ticket opens at dateAdded 00:00 UTC', () => {
  assert.equal(deadlineMs('2026-11-16'), Date.parse('2026-11-16T23:59:59.000Z'));
  assert.equal(openMs('2021-11-03'), Date.parse('2021-11-03T00:00:00.000Z'));
  assert.equal(dayNumber('1970-01-02'), 1);
  assert.throws(() => dayNumber('2026-02-30'), /bad date/);
  assert.throws(() => dayNumber('2026-2-3'), /bad date/);
});

test('truncateUtf8 never splits a code point', () => {
  assert.equal(truncateUtf8('abc'), 'abc');
  const s = `${'a'.repeat(79)}ètail`; // e-grave is 2 bytes and would straddle byte 80
  assert.equal(truncateUtf8(s), 'a'.repeat(79));
  assert.equal(bytes(truncateUtf8('–'.repeat(40))), 78); // en dash is 3 bytes: 26 fit
  assert.equal(truncateUtf8('\u{1F41B}'.repeat(30)).length, 40); // 20 four-byte emoji, 2 UTF-16 units each
});

test('toReport matches the contract TicketReport for real snapshot entries', async () => {
  const snap = await loadSnapshot();
  const byCve = new Map(snap.vulnerabilities.map((e) => [e.cveID, e]));
  const r = toReport(byCve.get('CVE-2020-11261'));
  assert.ok(bytes(r.product) <= 80);
  assert.ok(byCve.get('CVE-2020-11261').product.startsWith(r.product));
  assert.deepEqual(Object.keys(r), ['cve_id', 'vendor', 'product', 'date_added', 'due_date', 'ransomware', 'deadline_ms']);
  assert.equal(typeof r.deadline_ms, 'string');
  assert.match(r.deadline_ms, /^\d+$/);
  for (const e of snap.vulnerabilities) {
    const rep = toReport(e);
    assert.ok(bytes(rep.vendor) <= 80 && bytes(rep.product) <= 80, e.cveID);
    assert.equal(rep.ransomware, e.knownRansomwareCampaignUse === 'Known');
    assert.equal(Number(rep.deadline_ms) % 1000, 0);
  }
  assert.equal(snap.vulnerabilities.length, snap.count);
});

test('toReport refuses what the contract would refuse', () => {
  const base = { cveID: 'CVE-2026-1', vendorProject: 'V', product: 'P', dateAdded: '2026-11-13', dueDate: '2026-11-16', knownRansomwareCampaignUse: 'Unknown' };
  assert.throws(() => toReport({ ...base, cveID: 'GHSA-1234' }), /bad cve id/);
  assert.throws(() => toReport({ ...base, cveID: 'CVE-2026-12345678901234567' }), /bad cve id/);
  assert.throws(() => toReport({ ...base, dueDate: 'soon' }), /bad date/);
});

function fakeFetch(plan) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, ua: init.headers['user-agent'] });
    const p = plan[url];
    if (p instanceof Error) throw p;
    return { ok: p.status === 200, status: p.status, json: async () => p.body };
  };
  return { fn, calls };
}

test('fetchCatalog tries CISA first, then the mirror, with a browser user agent', async () => {
  const body = { catalogVersion: 'x', vulnerabilities: [{ cveID: 'CVE-2026-1', dateAdded: '2026-01-01', dueDate: '2026-01-02' }] };
  const ok = fakeFetch({ [CISA_FEED_URL]: { status: 200, body } });
  assert.equal((await fetchCatalog({ fetchImpl: ok.fn })).url, CISA_FEED_URL);
  assert.match(ok.calls[0].ua, /Mozilla/);

  const fallback = fakeFetch({ [CISA_FEED_URL]: { status: 403 }, [MIRROR_FEED_URL]: { status: 200, body } });
  const r = await fetchCatalog({ fetchImpl: fallback.fn });
  assert.equal(r.url, MIRROR_FEED_URL);
  assert.deepEqual(fallback.calls.map((c) => c.url), [CISA_FEED_URL, MIRROR_FEED_URL]);

  const bad = fakeFetch({ [CISA_FEED_URL]: new Error('ECONNRESET'), [MIRROR_FEED_URL]: { status: 200, body: { nope: 1 } } });
  await assert.rejects(fetchCatalog({ fetchImpl: bad.fn }), /ECONNRESET.*no vulnerabilities/);
});

test('standInTickets builds ABI-shaped open tickets ordered by deadline', async () => {
  const snap = await loadSnapshot();
  const now = Date.parse('2026-11-12T00:00:00Z');
  const t = standInTickets(snap.vulnerabilities, { nowMs: now });
  assert.ok(t.length > 0);
  assert.ok(t.every((x, i) => x.id === i && x.state === 'open' && Number(x.deadline_ms) > now));
  assert.ok(t.every((x, i) => i === 0 || Number(t[i - 1].deadline_ms) <= Number(x.deadline_ms)));
  assert.equal(t[0].burn_bps, t[0].ransomware ? 500 : 100);
});
