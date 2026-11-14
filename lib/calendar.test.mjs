import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HOLDERS,
  dayNumber,
  dayString,
  isBusinessDay,
  isMonday,
  isMonthStart,
  isQuarterStart,
  isSecondTuesday,
  nextBusinessDay,
  weekday,
} from './calendar.mjs';

const d = dayNumber;
const holder = (id) => HOLDERS.find((h) => h.id === id);
const FROM = d('2021-11-01');
const TO = d('2026-12-31');

test('weekday matches Date.getUTCDay for every day of the replay', () => {
  for (let day = FROM; day <= TO; day++) assert.equal(weekday(day), new Date(day * 86_400_000).getUTCDay(), dayString(day));
  assert.equal(weekday(d('2021-11-03')), 3); // first KEV day was a Wednesday
  assert.equal(weekday(d('1969-12-31')), 3); // negative day numbers still work
});

test('business days are Monday to Friday', () => {
  assert.equal(isBusinessDay(d('2026-11-13')), true); // Friday
  assert.equal(isBusinessDay(d('2026-11-14')), false);
  assert.equal(isBusinessDay(d('2026-11-15')), false);
  assert.equal(isBusinessDay(d('2026-11-16')), true);
  assert.equal(nextBusinessDay(d('2026-11-13')), d('2026-11-16'));
  assert.equal(nextBusinessDay(d('2026-11-14')), d('2026-11-16'));
  assert.equal(nextBusinessDay(d('2026-11-16')), d('2026-11-17'));
  assert.equal(isMonday(d('2026-11-16')), true);
  assert.equal(isMonday(d('2026-11-17')), false);
});

test('second Tuesday: known Microsoft Patch Tuesdays, and exactly one per month', () => {
  for (const date of ['2021-11-09', '2021-12-14', '2022-01-11', '2022-02-08', '2024-10-08', '2026-11-10']) {
    assert.equal(isSecondTuesday(d(date)), true, date);
  }
  for (const date of ['2021-11-02', '2021-11-16', '2022-03-01', '2026-11-03']) assert.equal(isSecondTuesday(d(date)), false, date);
  const perMonth = new Map();
  for (let day = FROM; day <= TO; day++) {
    if (!isSecondTuesday(day)) continue;
    const month = dayString(day).slice(0, 7);
    perMonth.set(month, (perMonth.get(month) ?? 0) + 1);
    // Brute force: exactly one earlier Tuesday in the same month.
    let earlier = 0;
    for (let x = day - 1; dayString(x).slice(0, 7) === month; x--) if (weekday(x) === 2) earlier += 1;
    assert.equal(earlier, 1, dayString(day));
  }
  assert.equal(perMonth.size, 62); // 2021-11 through 2026-12
  assert.ok([...perMonth.values()].every((n) => n === 1));
});

test('quarter starts and month starts', () => {
  for (const date of ['2022-01-01', '2022-04-01', '2022-07-01', '2022-10-01', '2026-10-01']) assert.equal(isQuarterStart(d(date)), true, date);
  for (const date of ['2022-02-01', '2022-04-02', '2021-12-31', '2022-03-01']) assert.equal(isQuarterStart(d(date)), false, date);
  let count = 0;
  for (let day = FROM; day <= TO; day++) if (isQuarterStart(day)) count += 1;
  assert.equal(count, 20); // 2022-01-01 through 2026-10-01
  assert.equal(isMonthStart(d('2024-03-01')), true);
  assert.equal(isMonthStart(d('2024-02-29')), false);
});

test('holder rules', () => {
  const fri = d('2026-11-13');
  const mon = d('2026-11-16');
  assert.equal(holder('on_call').canAnswer(fri, fri), true);
  assert.equal(holder('nine_to_five').canAnswer(fri, fri), false, 'never same day');
  assert.equal(holder('nine_to_five').canAnswer(fri + 1, fri), false, 'not on Saturday');
  assert.equal(holder('nine_to_five').canAnswer(mon, fri), true);
  assert.equal(holder('weekly').canAnswer(mon, mon), true, 'answers Monday tickets on Monday');
  assert.equal(holder('weekly').canAnswer(mon + 1, mon), false);
  assert.equal(holder('patch_tuesday').canAnswer(d('2026-11-10'), d('2026-11-01')), true);
  assert.equal(holder('quarterly').canAnswer(d('2026-10-01'), d('2026-09-30')), true);
  assert.equal(holder('ghost').canAnswer(mon, fri), false);
  assert.deepEqual(HOLDERS.map((h) => h.id), ['on_call', 'nine_to_five', 'weekly', 'patch_tuesday', 'quarterly', 'ghost']);
});
