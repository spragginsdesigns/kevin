import { test } from 'node:test';
import assert from 'node:assert/strict';
import { monthName, monthOf, orderRoster, plaqueFor, readRoster, rosterPages } from './roster.js';

const desk = (o) => ({ month_on_time: 0, streak: 0, month_missed: 0, first_on_call_ms: '1', ...o });
const entry = (id, o) => ({ account_id: id, desk: desk(o) });
const ids = (list) => list.map((e) => e.account_id);

test('monthOf matches the spec dates (UTC, Hinnant civil-from-days)', () => {
  const cases = [
    ['1970-01-01T00:00:00Z', 197001],
    ['2000-02-29T12:00:00Z', 200002],
    ['2024-02-29T23:59:59.999Z', 202402],
    ['2026-11-14T10:00:00Z', 202611],
    ['2026-11-30T23:59:59.999Z', 202611],
    ['2026-12-01T00:00:00Z', 202612],
    ['2027-01-01T00:00:00Z', 202701],
  ];
  for (const [iso, want] of cases) assert.equal(monthOf(Date.parse(iso)), want, iso);
});

test('monthOf agrees with Date for every day from 1970 to 2101', () => {
  for (let ms = 0; ms < Date.parse('2101-01-01'); ms += 86_400_000 - 1) {
    const d = new Date(ms);
    assert.equal(monthOf(ms), d.getUTCFullYear() * 100 + d.getUTCMonth() + 1, d.toISOString());
  }
});

test('monthName renders the heading month', () => {
  assert.equal(monthName(202611), 'November 2026');
  assert.equal(monthName(202701), 'January 2027');
});

test('order: month_on_time desc first', () => {
  const r = orderRoster([entry('a', { month_on_time: 1, streak: 50 }), entry('b', { month_on_time: 4 }), entry('c', { month_on_time: 2 })]);
  assert.deepEqual(ids(r), ['b', 'c', 'a']);
});

test('order: then streak desc', () => {
  const r = orderRoster([entry('a', { month_on_time: 3, streak: 2 }), entry('b', { month_on_time: 3, streak: 9 })]);
  assert.deepEqual(ids(r), ['b', 'a']);
});

test('order: then month_missed asc', () => {
  const r = orderRoster([entry('a', { month_on_time: 3, streak: 3, month_missed: 2 }), entry('b', { month_on_time: 3, streak: 3, month_missed: 0 })]);
  assert.deepEqual(ids(r), ['b', 'a']);
});

test('order: then first_on_call_ms asc, compared as U64 strings', () => {
  const r = orderRoster([
    entry('late', { first_on_call_ms: '1763100000000' }),
    entry('early', { first_on_call_ms: '999999999999' }),
  ]);
  assert.deepEqual(ids(r), ['early', 'late']);
});

test('order: full ties keep roster order, input is not mutated', () => {
  const input = [entry('x', {}), entry('y', {})];
  assert.deepEqual(ids(orderRoster(input)), ['x', 'y']);
  assert.deepEqual(ids(input), ['x', 'y']);
  assert.deepEqual(orderRoster(null), []);
});

test('plaque only for a first row that answered something this month', () => {
  assert.equal(plaqueFor([]), null);
  assert.equal(plaqueFor([entry('a', { month_on_time: 0, streak: 40 })]), null);
  assert.equal(plaqueFor([entry('a', { month_on_time: 1 })]).account_id, 'a');
});

test('rosterPages: no call for an empty roster, one for up to 25 desks', () => {
  assert.equal(rosterPages(0), 0);
  assert.equal(rosterPages(1), 1);
  assert.equal(rosterPages(25), 1);
  assert.equal(rosterPages(26), 2);
  assert.equal(rosterPages(50), 2);
  assert.equal(rosterPages(51), 3);
});

function fakeRoster(n) {
  const calls = [];
  const all = Array.from({ length: n }, (_, i) => entry(`d${i}`, {}));
  const get = async (from, limit) => {
    calls.push([from, limit]);
    return all.slice(from, from + Math.min(limit, 50));
  };
  return { get, calls, all };
}

test('readRoster with a known count: exactly the pages needed, at most 25 per call', async () => {
  for (const [n, pages] of [[0, 0], [6, 1], [25, 1], [26, 2], [60, 3]]) {
    const f = fakeRoster(n);
    const got = await readRoster(f.get, n);
    assert.equal(got.length, n);
    assert.equal(f.calls.length, pages, `roster of ${n}`);
    assert.ok(f.calls.every(([, l]) => l >= 1 && l <= 25));
    assert.equal(f.calls.reduce((s, [, l]) => s + l, 0), n, 'asks for exactly the desks there are');
  }
});

test('readRoster reads a failing page again in halves, so one neglected desk cannot blank the board', async () => {
  // desk 7 is too far behind: any page that includes it runs out of view gas
  const f = fakeRoster(12);
  const get = async (from, limit) => {
    if (from <= 7 && 7 < from + limit && limit > 1) throw new Error('GasLimitExceeded');
    return f.get(from, limit);
  };
  const got = await readRoster(get, 12);
  assert.deepEqual(got.map((e) => e.account_id), f.all.map((e) => e.account_id));
  // when even a page of one fails, the error reaches the caller
  const dead = async (from, limit) => {
    if (from <= 7 && 7 < from + limit) throw new Error('GasLimitExceeded');
    return f.get(from, limit);
  };
  await assert.rejects(readRoster(dead, 12), /GasLimitExceeded/);
});

test('readRoster without a count pages until a short page', async () => {
  const f = fakeRoster(30);
  const got = await readRoster(f.get, null);
  assert.equal(got.length, 30);
  assert.deepEqual(f.calls, [[0, 25], [25, 25]]);
});

test('readRoster passes a failed page through so the caller can keep the last roster', async () => {
  await assert.rejects(readRoster(async () => { throw new Error('Failed to fetch'); }, 3), /Failed to fetch/);
});
