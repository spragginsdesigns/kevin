import assert from 'node:assert/strict';
import test from 'node:test';
import { rankRoster } from './roster.mjs';

const entry = (account_id, month_on_time, streak, month_missed, first_on_call_ms) => ({
  account_id,
  desk: { on_call: true, month_on_time, streak, month_missed, first_on_call_ms: String(first_on_call_ms) },
});

test('rankRoster: month_on_time desc, streak desc, month_missed asc, first_on_call_ms asc', () => {
  const entries = [
    entry('late-joiner', 3, 1, 0, 300),
    entry('most-answers', 5, 0, 2, 900),
    entry('long-streak', 3, 7, 1, 800),
    entry('fewer-misses', 3, 1, 0, 400),
    entry('early-joiner', 3, 1, 0, 100),
    entry('more-misses', 3, 1, 4, 50),
    entry('nothing', 0, 0, 0, 10),
  ];
  assert.deepEqual(rankRoster(entries).map((e) => e.account_id), [
    'most-answers',
    'long-streak',
    'early-joiner',
    'late-joiner',
    'fewer-misses',
    'more-misses',
    'nothing',
  ]);
});

test('rankRoster: compares first_on_call_ms as integers, not text; does not change its input', () => {
  const entries = [entry('b', 1, 1, 0, '1794600000000'), entry('a', 1, 1, 0, '999')];
  const copy = structuredClone(entries);
  assert.deepEqual(rankRoster(entries).map((e) => e.account_id), ['a', 'b']);
  assert.deepEqual(entries, copy);
});

test('rankRoster: ties on every key keep roster order; empty input is an empty list', () => {
  const entries = [entry('x', 2, 2, 0, 5), entry('y', 2, 2, 0, 5), entry('z', 2, 2, 0, 5)];
  assert.deepEqual(rankRoster(entries).map((e) => e.account_id), ['x', 'y', 'z']);
  assert.deepEqual(rankRoster([]), []);
  assert.deepEqual(rankRoster(undefined), []);
});
