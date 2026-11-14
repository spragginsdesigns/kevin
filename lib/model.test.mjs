import assert from 'node:assert/strict';
import test from 'node:test';
import { Ledger, applyMiss, monthOf } from './model.mjs';

const K = 10n ** 18n;
const BAG = 10_000n * K;
const MIN = 1_000n * K;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function report(cve, deadlineMs, ransomware = false) {
  return { cve_id: cve, vendor: 'Vendor', product: 'Product', date_added: '2026-11-13', due_date: '2026-11-16', ransomware, deadline_ms: String(deadlineMs) };
}

function ledger(opts = {}) {
  return new Ledger({ minWindowMs: HOUR, maxOpen: 64, starterBag: BAG, initialSupply: 1_000_000_000n * K, minCommit: MIN, ...opts });
}

/** Register, claim the starter bag and, unless commit is 0n, go on call with `commit` (default the whole bag). */
function holder(l, id, at = 0, commit = BAG) {
  l.register(id, at);
  l.claimStarter(id, at);
  if (commit > 0n) l.goOnCall(id, commit, at);
}

test('applyMiss floors like the contract', () => {
  assert.deepEqual(applyMiss(999n, 100), { burned: 9n, balance: 990n });
  assert.deepEqual(applyMiss(99n, 100), { burned: 0n, balance: 99n });
  assert.deepEqual(applyMiss(BAG, 500), { burned: 500n * K, balance: 9_500n * K });
  assert.deepEqual(applyMiss('10000', 100), { burned: 100n, balance: 9_900n });
});

test('monthOf: YYYYMM in UTC on the dates the spec lists', () => {
  assert.equal(monthOf(0), 197001);
  assert.equal(monthOf(Date.UTC(2000, 1, 29)), 200002);
  assert.equal(monthOf(Date.UTC(2024, 1, 29, 12)), 202402);
  assert.equal(monthOf(Date.UTC(2026, 10, 14)), 202611);
  assert.equal(monthOf(Date.parse('2026-11-30T23:59:59.999Z')), 202611);
  assert.equal(monthOf(Date.parse('2026-12-01T00:00:00Z')), 202612);
  assert.equal(monthOf(Date.parse('2027-01-01T00:00:00Z')), 202701);
  assert.equal(monthOf(BigInt(Date.parse('2026-12-31T23:59:59.999Z'))), 202612);
  assert.equal(monthOf(String(Date.parse('2026-03-01T00:00:00Z'))), 202603);
});

test('min_commit must be at least 1', () => {
  assert.throws(() => new Ledger({ minCommit: 0n }), /^Error: min_commit must be at least 1$/);
});

test('happy path: on-call closer untouched, silent on-call desk burned 1% of its stake, supply falls by the burn', () => {
  const l = ledger();
  holder(l, 'alice');
  holder(l, 'bob');
  const t = l.open(report('CVE-2026-0001', 10 * HOUR), 0);
  assert.equal(t.burnBps, 100);
  l.close('alice', t.id, 'fixed', HOUR);
  const supply = l.totalSupply;
  // Past the deadline but nobody poked: views already show the burn, state has not changed.
  assert.equal(l.ticketState(t.id, 10 * HOUR), 'expired');
  assert.equal(l.balanceOf('bob', 10 * HOUR), 9_900n * K);
  const pending = l.desk('bob', 10 * HOUR);
  assert.equal(pending.pendingBurn, 100n * K);
  assert.equal(pending.committed, 9_900n * K);
  assert.equal(pending.storedCommitted, BAG);
  assert.equal(pending.missed, 1);
  assert.equal(l.totalSupply, supply);
  const r = l.settle('bob', undefined, 10 * HOUR);
  assert.equal(r.settled, 1);
  assert.equal(r.remaining, 0);
  assert.equal(r.burned, 100n * K);
  assert.equal(r.misses[0].memo, 'missed CVE-2026-0001');
  assert.equal(l.totalSupply, supply - 100n * K);
  assert.equal(l.balanceOf('bob', 10 * HOUR), 9_900n * K);
  assert.equal(l.settle('alice', undefined, 10 * HOUR).burned, 0n);
  assert.equal(l.balanceOf('alice', 10 * HOUR), BAG);
  const a = l.desk('alice', 10 * HOUR);
  assert.deepEqual([a.onTime, a.streak, a.onCall, a.balance, a.committed], [1, 1, true, 0n, BAG]);
  const b = l.desk('bob', 10 * HOUR);
  assert.deepEqual([b.missed, b.streak, b.burned, b.committed, b.storedCommitted], [1, 0, 100n * K, 9_900n * K, 9_900n * K]);
  assert.equal(l.tickets[t.id].missed, 1);
  assert.equal(l.tickets[t.id].burned, 100n * K);
  const s = l.stats(10 * HOUR);
  assert.deepEqual([s.onCall, s.committedTotal, s.roster, s.missesTotal], [2, 19_900n * K, 2, 1]);
});

test('ransomware ticket burns 5% and the reporter cannot choose the rate', () => {
  const l = ledger();
  holder(l, 'bob');
  const t = l.open({ ...report('CVE-2026-0002', 2 * HOUR, true), burn_bps: 1 }, 0);
  assert.equal(t.burnBps, 500);
  l.poke(2 * HOUR);
  assert.equal(l.settle('bob', undefined, 2 * HOUR).burned, 500n * K);
});

test('burns compound in expiry order on the committed amount', () => {
  const l = ledger();
  holder(l, 'bob');
  l.open(report('CVE-2026-0003', 2 * HOUR), 0);
  l.open(report('CVE-2026-0004', 3 * HOUR, true), 0);
  l.poke(4 * HOUR);
  const r = l.settle('bob', undefined, 4 * HOUR);
  assert.equal(r.burned, 100n * K + 495n * K); // 1% of 10000, then 5% of 9900
  assert.equal(l.balanceOf('bob', 4 * HOUR), 9_405n * K);
  assert.deepEqual(r.misses.map((m) => m.cveId), ['CVE-2026-0003', 'CVE-2026-0004']);
});

test('tickets expiring in one scan go in deadline order, then id order, like the contract', () => {
  const l = ledger();
  l.open(report('CVE-2026-0010', 5 * HOUR), 0);
  l.open(report('CVE-2026-0011', 2 * HOUR), 0);
  l.open(report('CVE-2026-0012', 2 * HOUR), 0);
  assert.equal(l.poke(6 * HOUR), 3);
  assert.deepEqual(l.expiredIds, [1, 2, 0]);
});

test('views project unpoked tickets in the same deadline-then-id order as expiry', () => {
  const l = ledger();
  holder(l, 'bob');
  l.open(report('CVE-2026-0013', 3 * HOUR, true), 0); // id 0, later deadline
  l.open(report('CVE-2026-0014', 2 * HOUR), 0); // id 1, earlier deadline
  const view = l.desk('bob', 4 * HOUR).committed; // nobody poked
  l.poke(4 * HOUR);
  l.settle('bob', undefined, 4 * HOUR);
  assert.equal(view, l.desk('bob', 4 * HOUR).committed);
  assert.equal(view, 9_405n * K); // 1% first (id 1), then 5% of 9900
});

test('go_on_call checks: registered, positive, minimum, free balance', () => {
  const l = ledger();
  l.register('alice', 0);
  l.claimStarter('alice', 0);
  assert.throws(() => l.goOnCall('nobody', MIN, 0), /^Error: register first: storage_deposit$/);
  assert.throws(() => l.goOnCall('alice', 0n, 0), /^Error: amount must be positive$/);
  assert.throws(() => l.goOnCall('alice', MIN - 1n, 0), /^Error: commit at least the minimum to go on call$/);
  assert.throws(() => l.goOnCall('alice', BAG + 1n, 0), /^Error: not enough free balance$/);
  assert.equal(l.desk('alice', 0).onCall, false, 'a refused call changes nothing');
  const d = l.goOnCall('alice', 4_000n * K, 0);
  assert.deepEqual([d.onCall, d.balance, d.committed, d.firstOnCallMs, d.month], [true, 6_000n * K, 4_000n * K, 0n, 197001]);
  // A top-up has no minimum, only the free balance limit.
  assert.equal(l.goOnCall('alice', 1n, HOUR).committed, 4_000n * K + 1n);
  assert.throws(() => l.goOnCall('alice', 6_000n * K, HOUR), /^Error: not enough free balance$/);
  assert.equal(l.balanceOf('alice', HOUR), BAG);
});

test('cheat 1: committed tokens cannot move; transferring more than the free balance fails and the miss burns', () => {
  const l = ledger();
  holder(l, 'bob', 0, 4_000n * K);
  l.register('carol', 0);
  const t = l.open(report('CVE-2026-0020', 10 * HOUR), 0);
  assert.throws(() => l.transfer('bob', 'carol', 6_000n * K + 1n, 9 * HOUR), /^Error: not enough free balance: committed tokens cannot move$/);
  assert.throws(() => l.transfer('bob', 'carol', BAG + 1n, 9 * HOUR), /^Error: The account doesn't have enough balance$/);
  l.transfer('bob', 'carol', 6_000n * K, 9 * HOUR);
  l.poke(10 * HOUR);
  assert.equal(l.settle('bob', undefined, 10 * HOUR).burned, 40n * K);
  assert.equal(l.settle('carol', undefined, 10 * HOUR).settled, 0); // carol never went on call
  assert.equal(l.balanceOf('carol', 10 * HOUR), 6_000n * K);
  assert.equal(l.tickets[t.id].missed, 1);
});

test('cheat 2: clock-out is refused while an open ticket has no answer; the miss then burns', () => {
  const l = ledger();
  holder(l, 'bob');
  const t = l.open(report('CVE-2026-0021', 10 * HOUR), 0);
  assert.throws(() => l.clockOut('bob', 10 * HOUR - 1), /^Error: answer every open ticket before you clock out$/);
  assert.equal(l.desk('bob', 10 * HOUR - 1).onCall, true);
  // After the deadline the ticket is no longer open, so clocking out works, but only after the miss settles.
  const d = l.clockOut('bob', 10 * HOUR);
  assert.deepEqual([d.onCall, d.committed, d.balance, d.missed, d.burned], [false, 0n, 9_900n * K, 1, 100n * K]);
  assert.equal(l.tickets[t.id].burned, 100n * K);
  assert.throws(() => l.clockOut('bob', 11 * HOUR), /^Error: not on call$/);
  assert.throws(() => l.clockOut('nobody', 11 * HOUR), /^Error: not on call$/);
});

test('cheat 3: a desk that is not on call cannot answer', () => {
  const l = ledger();
  holder(l, 'alice', 0, 0n);
  const t = l.open(report('CVE-2026-0022', 10 * HOUR), 0);
  assert.throws(() => l.close('alice', t.id, 'fixed', HOUR), /^Error: go on call first: go_on_call$/);
  assert.throws(() => l.close('nobody', t.id, 'fixed', HOUR), /^Error: register first: storage_deposit$/);
  assert.equal(l.tickets[t.id].closes, 0);
});

test('cheat 4: closing at or after the deadline is refused', () => {
  const l = ledger();
  holder(l, 'bob');
  const t = l.open(report('CVE-2026-0023', 10 * HOUR), 0);
  assert.throws(() => l.close('bob', t.id, 'fixed', 10 * HOUR), /^Error: deadline passed$/);
  assert.throws(() => l.close('bob', t.id, 'fixed', 11 * HOUR), /^Error: deadline passed$/);
  assert.throws(() => l.close('bob', 99, 'fixed', 0), /^Error: no such ticket$/);
});

test('cheat 5: ticket rules (window, duplicate, cve id, field length)', () => {
  const l = ledger();
  assert.throws(() => l.open(report('CVE-2026-0030', HOUR - 1), 0), /^Error: window too short$/);
  l.open(report('CVE-2026-0030', HOUR), 0);
  assert.throws(() => l.open(report('CVE-2026-0030', 5 * HOUR), 0), /^Error: ticket exists$/);
  assert.throws(() => l.open(report('CVE-26-1', 5 * HOUR), 0), /^Error: bad cve id$/);
  assert.throws(() => l.open(report('CVE-2026-12345678901234567', 5 * HOUR), 0), /^Error: bad cve id$/);
  assert.throws(() => l.open({ ...report('CVE-2026-0031', 5 * HOUR), vendor: 'x'.repeat(81) }, 0), /^Error: field too long$/);
  assert.throws(() => l.open({ ...report('CVE-2026-0031', 5 * HOUR), due_date: '2026-1-16' }, 0), /^Error: field too long$/);
});

test('cheat 6: junk tickets cost an attentive desk nothing, and max_open bounds them', () => {
  const l = ledger({ maxOpen: 2 });
  holder(l, 'alice');
  const a = l.open(report('CVE-2099-0001', 2 * HOUR), 0);
  const b = l.open(report('CVE-2099-0002', 2 * HOUR), 0);
  assert.throws(() => l.open(report('CVE-2099-0003', 2 * HOUR), 0), /^Error: too many open tickets$/);
  l.close('alice', a.id, 'not_affected', 1);
  l.close('alice', b.id, 'not_affected', 1);
  l.poke(2 * HOUR);
  assert.equal(l.settle('alice', undefined, 2 * HOUR).burned, 0n);
  // Expired tickets free their slots, but the day's activations are used up until the next UTC day.
  assert.throws(() => l.open(report('CVE-2099-0003', 4 * HOUR), 2 * HOUR), /^Error: too many tickets today$/);
  l.open(report('CVE-2099-0003', 27 * HOUR), 25 * HOUR);
});

test('cheat 8: going on call after a ticket expired is not liable for it; an already open one is', () => {
  const l = ledger();
  holder(l, 'eve', 0, 0n);
  const old = l.open(report('CVE-2026-0024', 2 * HOUR), 0);
  const open = l.open(report('CVE-2026-0025', 10 * HOUR), 0);
  l.goOnCall('eve', BAG, 3 * HOUR);
  assert.equal(l.desk('eve', 3 * HOUR).unsettled, 0);
  l.poke(10 * HOUR);
  const r = l.settle('eve', undefined, 10 * HOUR);
  assert.deepEqual([r.settled, r.burned], [1, 100n * K]);
  assert.equal(l.tickets[old.id].missed, 0);
  assert.equal(l.tickets[open.id].missed, 1);
});

test('cheat 9: a top-up settles first, so a miss that is already due burns at the old committed amount', () => {
  const l = ledger();
  holder(l, 'alice', 0, 4_000n * K);
  l.open(report('CVE-2026-0026', 2 * HOUR), 0);
  const d = l.goOnCall('alice', 6_000n * K, 3 * HOUR);
  assert.equal(d.burned, 40n * K); // 1% of 4,000, not of 10,000
  assert.equal(d.committed, 3_960n * K + 6_000n * K);
  assert.deepEqual([d.balance, d.pendingBurn, d.unsettled], [0n, 0n, 0]);
  assert.equal(l.committedTotal, 9_960n * K);
});

test('a top-up or clock-out more than 50 tickets behind is refused with "account behind"', () => {
  const l = ledger({ maxOpen: Infinity });
  holder(l, 'bob', 0, 4_000n * K);
  for (let i = 0; i < 51; i++) l.open(report(`CVE-2026-${2000 + i}`, 2 * HOUR), 0);
  l.poke(2 * HOUR);
  assert.throws(() => l.goOnCall('bob', K, 2 * HOUR), /^Error: account behind: call settle first$/);
  assert.throws(() => l.clockOut('bob', 2 * HOUR), /^Error: account behind: call settle first$/);
  assert.equal(l.desk('bob', 2 * HOUR).unsettled, 51, 'a refused call settles nothing');
  l.settle('bob', 1, 2 * HOUR);
  l.goOnCall('bob', K, 2 * HOUR);
  assert.equal(l.desk('bob', 2 * HOUR).unsettled, 0);
});

test('cheat 10: clock out with a clean queue; later expiries do not burn; rejoining is liable only from then on', () => {
  const l = ledger();
  holder(l, 'alice', 1);
  const answered = l.open(report('CVE-2026-0027', 10 * HOUR), 1);
  l.close('alice', answered.id, 'fixed', HOUR);
  const d = l.clockOut('alice', 2 * HOUR);
  assert.deepEqual([d.onCall, d.balance, d.committed, d.onTime], [false, BAG, 0n, 1]);
  assert.equal(l.stats(2 * HOUR).onCall, 0);
  assert.equal(l.stats(2 * HOUR).committedTotal, 0n);
  const missedWhileOff = l.open(report('CVE-2026-0028', 5 * HOUR), 3 * HOUR);
  const spansRejoin = l.open(report('CVE-2026-0029', 20 * HOUR), 3 * HOUR);
  l.poke(12 * HOUR);
  assert.deepEqual(l.settle('alice', undefined, 12 * HOUR), { settled: 0, remaining: 0, burned: 0n, misses: [] });
  assert.equal(l.balanceOf('alice', 12 * HOUR), BAG);
  assert.equal(l.tickets[missedWhileOff.id].missed, 0);
  assert.equal(l.desk('alice', 12 * HOUR).unsettled, 0);
  // Rejoin: not liable for what expired while off call, liable for the ticket that expires after rejoining.
  l.goOnCall('alice', 5_000n * K, 13 * HOUR);
  l.poke(20 * HOUR);
  assert.equal(l.settle('alice', undefined, 20 * HOUR).burned, 50n * K);
  assert.equal(l.tickets[spansRejoin.id].missed, 1);
  assert.equal(l.balanceOf('alice', 20 * HOUR), BAG - 50n * K);
  assert.equal(l.desk('alice', 20 * HOUR).firstOnCallMs, 1n, 'first time on call is kept');
  assert.equal(l.stats(20 * HOUR).roster, 1);
});

test('cheat 13: answering what is open and clocking out right away is refused until the shift is over', () => {
  const SHIFT = 7 * DAY;
  const l = ledger({ minShiftMs: SHIFT });
  holder(l, 'alice', HOUR);
  const open = l.open(report('CVE-2026-0070', 3 * DAY), HOUR);
  l.close('alice', open.id, 'fixed', 2 * HOUR);
  assert.throws(() => l.clockOut('alice', 2 * HOUR), /^Error: your shift is not over$/);
  const later = l.open(report('CVE-2026-0071', 4 * DAY), 3 * HOUR);
  l.poke(4 * DAY);
  assert.equal(l.settle('alice', undefined, 4 * DAY).burned, 100n * K);
  assert.equal(l.tickets[later.id].missed, 1);
});

test('shift: view fields, allowed at exactly since + min_shift, a top-up does not restart it, rejoining does', () => {
  const SHIFT = 30 * 60_000;
  const l = ledger({ minShiftMs: SHIFT });
  holder(l, 'bob', 1_000, 4_000n * K);
  let d = l.desk('bob', 2_000);
  assert.deepEqual([d.onCallSinceMs, d.shiftEndsMs], [1_000n, BigInt(1_000 + SHIFT)]);
  l.goOnCall('bob', 1_000n * K, 5_000); // top-up
  assert.equal(l.desk('bob', 5_000).shiftEndsMs, BigInt(1_000 + SHIFT));
  assert.throws(() => l.clockOut('bob', 1_000 + SHIFT - 1), /^Error: your shift is not over$/);
  d = l.clockOut('bob', 1_000 + SHIFT);
  assert.deepEqual([d.onCall, d.onCallSinceMs, d.shiftEndsMs, d.balance], [false, 1_000n, 0n, BAG]);
  const rejoin = 1_000 + 2 * SHIFT;
  d = l.goOnCall('bob', MIN, rejoin);
  assert.deepEqual([d.onCallSinceMs, d.shiftEndsMs], [BigInt(rejoin), BigInt(rejoin + SHIFT)]);
  assert.throws(() => l.clockOut('bob', rejoin + SHIFT - 1), /^Error: your shift is not over$/);
  l.clockOut('bob', rejoin + SHIFT);
});

test('an answer more than 50 tickets behind is refused, so a streak cannot grow across an unsettled miss', () => {
  const l = ledger({ maxOpen: Infinity });
  holder(l, 'bob', 0, 4_000n * K);
  for (let i = 0; i < 51; i++) l.open(report(`CVE-2026-${6000 + i}`, 2 * HOUR), 0);
  const live = l.open(report('CVE-2026-6999', 10 * HOUR), 0);
  l.poke(2 * HOUR);
  const before = l.desk('bob', 2 * HOUR);
  assert.throws(() => l.close('bob', live.id, 'fixed', 3 * HOUR), /^Error: account behind: call settle first$/);
  const refused = l.desk('bob', 3 * HOUR);
  assert.deepEqual([refused.onTime, refused.streak, refused.bestStreak], [before.onTime, before.streak, before.bestStreak]);
  l.settle('bob', 200, 3 * HOUR);
  l.close('bob', live.id, 'fixed', 3 * HOUR);
  const after = l.desk('bob', 3 * HOUR);
  assert.deepEqual([after.onTime, after.streak, after.missed], [1, 1, 51]);
});

test('clock_out check order: not on call, behind, shift, then open tickets', () => {
  const l = ledger({ minShiftMs: 10 * HOUR, maxOpen: Infinity });
  holder(l, 'bob', 1);
  l.open(report('CVE-2026-0080', 20 * HOUR), 1);
  // Inside the shift with an unanswered open ticket: the shift is what the panic names.
  assert.throws(() => l.clockOut('bob', 2), /^Error: your shift is not over$/);
  assert.throws(() => l.clockOut('bob', 10 * HOUR + 1), /^Error: answer every open ticket before you clock out$/);
  for (let i = 0; i < 51; i++) l.open(report(`CVE-2026-${4000 + i}`, 3 * HOUR), 1);
  l.poke(3 * HOUR);
  assert.throws(() => l.clockOut('bob', 3 * HOUR), /^Error: account behind: call settle first$/);
});

test('cheat 11: free tokens never burn; 6,000 free and 4,000 committed loses 1% of 4,000', () => {
  const l = ledger();
  holder(l, 'bob', 0, 4_000n * K);
  holder(l, 'holder', 0, 0n);
  l.open(report('CVE-2026-0032', 2 * HOUR), 0);
  const view = l.desk('bob', 2 * HOUR);
  assert.deepEqual([view.balance, view.committed, view.pendingBurn], [6_000n * K, 3_960n * K, 40n * K]);
  assert.equal(l.balanceOf('bob', 2 * HOUR), 9_960n * K);
  l.poke(2 * HOUR);
  l.settle('bob', undefined, 2 * HOUR);
  assert.equal(l.balances.get('bob'), 6_000n * K);
  // A holder that never went on call: nothing pending, nothing burned, never behind.
  const h = l.desk('holder', 2 * HOUR);
  assert.deepEqual([h.onCall, h.balance, h.missed, h.burned, h.unsettled], [false, BAG, 0, 0n, 0]);
  assert.deepEqual(l.settle('holder', undefined, 2 * HOUR), { settled: 0, remaining: 0, burned: 0n, misses: [] });
});

test('cheat 12: the desk pool is exempt and only claim_starter takes from it', () => {
  const l = ledger({ initialSupply: BAG });
  const pool = l.balances.get(l.poolId);
  l.open(report('CVE-2026-0040', 2 * HOUR), 0);
  l.poke(2 * HOUR);
  assert.equal(l.settle(l.poolId, undefined, 2 * HOUR).settled, 0);
  assert.equal(l.balanceOf(l.poolId, 2 * HOUR), pool);
  assert.deepEqual([l.desk(l.poolId, 2 * HOUR).registered, l.desk(l.poolId, 2 * HOUR).balance], [true, pool]);
  holder(l, 'alice', 3 * HOUR);
  assert.throws(() => l.claimStarter('alice', 3 * HOUR), /^Error: starter already claimed$/);
  l.register('bob', 3 * HOUR);
  assert.throws(() => l.claimStarter('bob', 3 * HOUR), /^Error: desk pool is empty$/);
  assert.throws(() => l.claimStarter('nobody', 3 * HOUR), /^Error: register first: storage_deposit$/);
  // A plain transfer to the pool still works and stays there.
  l.clockOut('alice', 3 * HOUR);
  l.transfer('alice', l.poolId, K, 3 * HOUR);
  assert.equal(l.balances.get(l.poolId), K);
});

test('transfers move the free balance with no settle; balances add up to supply once burns settle', () => {
  const l = ledger();
  holder(l, 'alice', 0, 4_000n * K);
  holder(l, 'bob', 0, 0n);
  l.open(report('CVE-2026-0041', 2 * HOUR), 0);
  l.transfer('alice', 'bob', 1_000n * K, 3 * HOUR); // alice has an unsettled miss: no settle, no refusal
  assert.equal(l.desk('alice', 3 * HOUR).unsettled, 1);
  assert.equal(l.balanceOf('bob', 3 * HOUR), 11_000n * K);
  l.settle('alice', undefined, 3 * HOUR);
  const sum = [...l.balances.values()].reduce((a, b) => a + b, 0n) + l.committedTotal;
  assert.equal(sum, l.totalSupply);
  assert.equal(l.balanceOf('alice', 3 * HOUR), 5_000n * K + 3_960n * K);
});

test('settle limit and remaining', () => {
  const l = ledger({ maxOpen: Infinity });
  holder(l, 'bob');
  for (let i = 0; i < 51; i++) l.open(report(`CVE-2026-${1000 + i}`, 2 * HOUR), 0);
  l.poke(2 * HOUR);
  const r = l.settle('bob', 2, 2 * HOUR);
  assert.deepEqual([r.settled, r.remaining], [2, 49]);
  assert.equal(l.settle('bob', 500, 2 * HOUR).settled, 49); // limit is capped at 200, 49 were left
  assert.equal(l.stats(2 * HOUR).missesTotal, 51);
});

test('a later statement replaces the status without changing the record', () => {
  const l = ledger();
  holder(l, 'alice');
  const t = l.open(report('CVE-2026-0050', 10 * HOUR), 0);
  l.close('alice', t.id, 'fixed', HOUR);
  const s = l.close('alice', t.id, 'mitigated', 2 * HOUR);
  assert.deepEqual(s, { status: 'mitigated', atMs: BigInt(2 * HOUR) });
  assert.deepEqual(l.tickets[t.id].counts, { not_affected: 0, fixed: 0, mitigated: 1 });
  assert.equal(l.tickets[t.id].closes, 1);
  assert.equal(l.desk('alice', 3 * HOUR).onTime, 1);
  assert.equal(l.desk('alice', 3 * HOUR).streak, 1);
  assert.equal(l.desk('alice', 3 * HOUR).monthOnTime, 1);
  assert.equal(l.stats(3 * HOUR).statementsTotal, 1);
});

test('roster: first time on call order, capped pages, clocked-out desks stay', () => {
  const l = ledger({ initialSupply: 100_000_000n * K });
  for (let i = 0; i < 60; i++) holder(l, `d${i}`, i + 1);
  holder(l, 'never', 0, 0n);
  assert.equal(l.getRoster(0, 100, 100).length, 50);
  assert.deepEqual(l.getRoster(48, 25, 100).map((e) => e.accountId), ['d48', 'd49', 'd50', 'd51', 'd52', 'd53', 'd54', 'd55', 'd56', 'd57', 'd58', 'd59']);
  l.clockOut('d0', 100);
  l.goOnCall('d0', MIN, 200); // rejoining does not move it
  l.clockOut('d1', 100);
  const first = l.getRoster(0, 3, 300);
  assert.deepEqual(first.map((e) => [e.accountId, e.desk.onCall, e.desk.firstOnCallMs]), [['d0', true, 1n], ['d1', false, 2n], ['d2', true, 3n]]);
  assert.equal(l.stats(300).roster, 60);
  assert.ok(!l.roster.includes('never'));
});

test('monthly counters: on time this month, reset on a new month, pending misses counted by deadline month', () => {
  const l = ledger();
  const nov14 = Date.parse('2026-11-14T00:00:00Z');
  const nov30End = Date.parse('2026-11-30T23:59:59Z');
  const dec2 = Date.parse('2026-12-02T00:00:00Z');
  holder(l, 'alice', nov14);
  const a = l.open(report('CVE-2026-0060', nov14 + 2 * DAY), nov14);
  const b = l.open(report('CVE-2026-0061', nov30End), nov14);
  l.close('alice', a.id, 'fixed', nov14 + HOUR);
  let d = l.desk('alice', nov14 + 3 * DAY);
  assert.deepEqual([d.month, d.monthOnTime, d.monthMissed, d.monthBurned], [202611, 1, 0, 0n]);
  // b expires unanswered on Nov 30. Before anyone settles, the view counts it in November.
  d = l.desk('alice', nov30End + 1);
  assert.deepEqual([d.month, d.monthOnTime, d.monthMissed, d.monthBurned], [202611, 1, 1, 100n * K]);
  // In December the stored November counters and the November miss no longer count for "this month".
  d = l.desk('alice', dec2);
  assert.deepEqual([d.month, d.monthOnTime, d.monthMissed, d.monthBurned, d.missed], [202612, 0, 0, 0n, 1]);
  l.poke(dec2);
  l.settle('alice', undefined, dec2);
  d = l.desk('alice', dec2);
  assert.deepEqual([d.month, d.monthOnTime, d.monthMissed, d.monthBurned], [202612, 0, 0, 0n]);
  assert.equal(l.desks.get('alice').month, 202611, 'the late miss was booked to its deadline month');
  assert.equal(l.desks.get('alice').monthMissed, 1);
  assert.equal(l.tickets[b.id].missed, 1);
});

test('November misses are booked to November even when they settle in December, before a December answer counts', () => {
  const l = ledger({ maxOpen: Infinity });
  const nov20 = Date.parse('2026-11-20T00:00:00Z');
  const nov30End = Date.parse('2026-11-30T23:59:59Z');
  const dec1 = Date.parse('2026-12-01T06:00:00Z');
  holder(l, 'alice', nov20);
  for (let i = 0; i < 51; i++) l.open(report(`CVE-2026-${3000 + i}`, nov30End), nov20);
  const dec = l.open(report('CVE-2026-3100', Date.parse('2026-12-05T23:59:59Z')), nov20);
  // 51 November misses are due. An answer cannot jump the queue: the desk has to be settled first, so no
  // December event is ever recorded ahead of an older miss.
  assert.throws(() => l.close('alice', dec.id, 'fixed', dec1), /^Error: account behind: call settle first$/);
  // Seen from December before anything is settled: nothing counts toward December.
  let d = l.desk('alice', dec1);
  assert.deepEqual([d.month, d.monthOnTime, d.monthMissed, d.monthBurned, d.missed], [202612, 0, 0, 0n, 51]);
  l.settle('alice', 200, dec1);
  let stored = l.desks.get('alice');
  assert.deepEqual([stored.month, stored.monthMissed, stored.missed], [202611, 51, 51]);
  // The December answer starts December's counters from zero.
  l.close('alice', dec.id, 'fixed', dec1);
  stored = l.desks.get('alice');
  assert.deepEqual([stored.month, stored.monthOnTime, stored.monthMissed, stored.monthBurned, stored.missed], [202612, 1, 0, 0n, 51]);
  d = l.desk('alice', dec1);
  assert.deepEqual([d.monthOnTime, d.monthMissed, d.monthBurned], [1, 0, 0n]);
});

test('a deadline further out than 200 days is refused', () => {
  const l = ledger();
  assert.throws(() => l.open(report('CVE-2026-0020', 201 * 24 * HOUR), 0), /window too long/);
  l.open(report('CVE-2026-0021', 200 * 24 * HOUR), 0);
});

test('activations are capped at maxOpen per UTC day', () => {
  const l = new Ledger({ maxOpen: 2, initialSupply: 0n });
  l.open(report('CVE-2026-0030', 2 * HOUR), 0);
  l.open(report('CVE-2026-0031', 2 * HOUR), 0);
  l.poke(3 * HOUR);
  assert.throws(() => l.open(report('CVE-2026-0032', 9 * HOUR), 4 * HOUR), /too many tickets today/);
  l.open(report('CVE-2026-0032', 30 * HOUR), 25 * HOUR);
});
