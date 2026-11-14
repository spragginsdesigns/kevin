// Reporter selection and on-call triage, with fixtures. No network.
import assert from 'node:assert/strict';
import test from 'node:test';
import { matchInventory, notOnCallLine, pageLine, parseInventory, triage } from './oncall-triage.mjs';
import { candidates, isBenignReportError, planReports } from './reporter-plan.mjs';

const NOW = Date.parse('2026-11-13T22:00:00Z');
const HOUR = 3_600_000;
const e = (cveID, dueDate, extra = {}) => ({
  cveID, vendorProject: 'Vendor', product: 'Product', dateAdded: '2026-11-10', dueDate, knownRansomwareCampaignUse: 'Unknown', ...extra,
});

test('candidates: only entries whose deadline clears min_window plus margin, soonest first', () => {
  const entries = [
    e('CVE-2026-0005', '2026-11-24'),
    e('CVE-2026-0001', '2026-11-13'), // deadline 23:59:59 today: 1h59m59s left
    e('CVE-2026-0002', '2026-11-12'), // already past
    e('CVE-2026-0003', '2026-11-16', { knownRansomwareCampaignUse: 'Known' }),
    e('not-a-cve', '2026-11-30'),
    e('CVE-2026-0003', '2026-11-16'), // duplicate
  ];
  const tight = candidates(entries, { nowMs: NOW, minWindowMs: HOUR, marginMs: HOUR / 2 });
  assert.deepEqual(tight.reports.map((r) => r.cve_id), ['CVE-2026-0001', 'CVE-2026-0003', 'CVE-2026-0005']);
  assert.equal(tight.reports[1].ransomware, true);
  assert.deepEqual(tight.skipped.map((s) => s.reason), ['bad cve id: not-a-cve', 'duplicate in catalog']);
  const strict = candidates(entries, { nowMs: NOW, minWindowMs: HOUR, marginMs: 2 * HOUR });
  assert.deepEqual(strict.reports.map((r) => r.cve_id), ['CVE-2026-0003', 'CVE-2026-0005']);
  // Exactly at the boundary is allowed, one millisecond short is not (contract: deadline < now + window panics).
  const due = Date.parse('2026-11-16T23:59:59Z');
  assert.equal(candidates([e('CVE-2026-0009', '2026-11-16')], { nowMs: due - HOUR, minWindowMs: HOUR, marginMs: 0 }).reports.length, 1);
  assert.equal(candidates([e('CVE-2026-0009', '2026-11-16')], { nowMs: due - HOUR + 1, minWindowMs: HOUR, marginMs: 0 }).reports.length, 0);
});

test('planReports: skips what is on chain and respects free open slots', () => {
  const { reports } = candidates([e('CVE-2026-0001', '2026-11-16'), e('CVE-2026-0002', '2026-11-18'), e('CVE-2026-0003', '2026-11-20')], { nowMs: NOW, minWindowMs: HOUR });
  const plan = planReports(reports, { onChain: new Set(['CVE-2026-0001']), freeSlots: 1 });
  assert.deepEqual(plan.send.map((r) => r.cve_id), ['CVE-2026-0002']);
  assert.deepEqual(plan.held.map((r) => r.cve_id), ['CVE-2026-0003']);
  assert.equal(planReports(reports, { onChain: new Set(), freeSlots: 0 }).send.length, 0);
  // Second run after everything landed: nothing to send.
  assert.equal(planReports(reports, { onChain: new Set(reports.map((r) => r.cve_id)), freeSlots: 64 }).send.length, 0);
});

test('benign report panics make a rerun a no-op', () => {
  assert.equal(isBenignReportError('already confirmed'), true);
  assert.equal(isBenignReportError('ticket exists'), true);
  assert.equal(isBenignReportError('window too short'), false);
  assert.equal(isBenignReportError('not a reporter'), false);
});

const ticket = (id, vendor, product, extra = {}) => ({ id, cve_id: `CVE-2026-${1000 + id}`, vendor, product, state: 'open', ransomware: false, deadline_ms: String(NOW + 48 * HOUR), ...extra });

test('parseInventory validates and lowercases', () => {
  const inv = parseInventory([{ vendor: ' Microsoft ', product: 'Windows' }, { vendor: 'Apple' }]);
  assert.deepEqual(inv.map(({ vendor, product }) => [vendor, product]), [['microsoft', 'windows'], ['apple', undefined]]);
  assert.throws(() => parseInventory({}), /JSON array/);
  assert.throws(() => parseInventory([{ product: 'x' }]), /vendor must be/);
  assert.throws(() => parseInventory([{ vendor: 'x', product: '' }]), /product, when given/);
  assert.equal(parseInventory({ inventory: [{ vendor: 'x' }] }).length, 1);
});

test('matchInventory: case-insensitive substrings, product optional', () => {
  const inv = parseInventory([{ vendor: 'microsoft', product: 'exchange' }, { vendor: 'APPLE' }]);
  assert.equal(matchInventory(ticket(1, 'Microsoft', 'Exchange Server'), inv)?.raw.product, 'exchange');
  assert.equal(matchInventory(ticket(2, 'Microsoft', 'Windows'), inv), null);
  assert.equal(matchInventory(ticket(3, 'Apple', 'Multiple Products'), inv)?.raw.vendor, 'APPLE');
  assert.equal(matchInventory(ticket(4, 'Pineapple Labs', 'X'), inv)?.raw.vendor, 'APPLE', 'substring by design');
});

test('triage: close unmatched, page matched, skip answered and expired', () => {
  const inv = parseInventory([{ vendor: 'Fortinet' }]);
  const tickets = [
    ticket(0, 'Cisco', 'IOS'),
    ticket(1, 'Fortinet', 'FortiOS', { ransomware: true }),
    ticket(2, 'Cisco', 'ASA'),
    ticket(3, 'Cisco', 'ASA', { deadline_ms: String(NOW - 1) }),
    ticket(4, 'Cisco', 'ASA', { state: 'expired' }),
  ];
  const statements = [null, null, { status: 'fixed', at_ms: '1' }, null, null];
  const out = triage({ tickets, statements, inventory: inv, nowMs: NOW });
  assert.deepEqual(out.map((d) => d.action), ['close', 'page', 'skip', 'skip', 'skip']);
  assert.match(out[2].reason, /already answered fixed/);
  assert.equal(out[3].reason, 'deadline passed');
  const line = pageLine(tickets[1], 'Apply updates per vendor instructions.');
  assert.match(line, /^PAGE CVE-2026-1001 \[RANSOMWARE\] Fortinet FortiOS \| deadline 2026-11-15T22:00:00.000Z \| ticket #1 \| CISA: Apply updates/);
  assert.match(pageLine(tickets[0]), /cisa\.gov\/known-exploited-vulnerabilities-catalog/);
});

test('notOnCallLine: the bot stops unless the desk is on call', () => {
  const line = 'bob.testnet is not on call on pager.testnet: go_on_call first';
  assert.equal(notOnCallLine({ registered: true, on_call: false }, 'bob.testnet', 'pager.testnet'), line);
  assert.equal(notOnCallLine({ registered: false }, 'bob.testnet', 'pager.testnet'), line);
  assert.equal(notOnCallLine(null, 'bob.testnet', 'pager.testnet'), line);
  assert.equal(notOnCallLine({ registered: true, on_call: true }, 'bob.testnet', 'pager.testnet'), null);
});
