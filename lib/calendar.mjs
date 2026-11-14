// Holder calendars for the simulation. Everything is in UTC day numbers (days since 1970-01-01), because
// the contract's deadlines are UTC instants and a local-time calendar would silently shift answers across
// a deadline. Business days are Monday to Friday; public holidays are deliberately not modeled.

import { dayNumber, dayString } from './kev.mjs';

/** 0 = Sunday ... 6 = Saturday. 1970-01-01 was a Thursday. */
export function weekday(day) {
  return (((day + 4) % 7) + 7) % 7;
}

function parts(day) {
  const d = new Date(day * 86_400_000);
  return { month: d.getUTCMonth() + 1, dom: d.getUTCDate() };
}

export const isBusinessDay = (day) => weekday(day) >= 1 && weekday(day) <= 5;
export const isMonday = (day) => weekday(day) === 1;
// The second Tuesday always falls on day-of-month 8 to 14.
export const isSecondTuesday = (day) => weekday(day) === 2 && parts(day).dom >= 8 && parts(day).dom <= 14;
export const isQuarterStart = (day) => {
  const { month, dom } = parts(day);
  return dom === 1 && (month === 1 || month === 4 || month === 7 || month === 10);
};
export const isMonthStart = (day) => parts(day).dom === 1;

/** First business day strictly after `day`. */
export function nextBusinessDay(day) {
  let d = day + 1;
  while (!isBusinessDay(d)) d += 1;
  return d;
}

/**
 * The holder types. `canAnswer(day, addedDay)` says whether a holder that is active on UTC day `day`
 * answers a ticket that opened on `addedDay` (the simulation separately requires the deadline not to
 * have passed). nine_to_five works through its inbox the next business day, so it never answers a
 * ticket on the day it opened; the others answer everything open on the days they work.
 */
export const HOLDERS = Object.freeze([
  { id: 'on_call', label: 'On call (same day)', canAnswer: () => true },
  { id: 'nine_to_five', label: 'Nine to five (next business day)', canAnswer: (day, added) => isBusinessDay(day) && added < day },
  { id: 'weekly', label: 'Weekly (Mondays)', canAnswer: (day) => isMonday(day) },
  { id: 'patch_tuesday', label: 'Patch Tuesday (2nd Tuesday monthly)', canAnswer: (day) => isSecondTuesday(day) },
  { id: 'quarterly', label: 'Quarterly (Jan, Apr, Jul, Oct 1)', canAnswer: (day) => isQuarterStart(day) },
  { id: 'ghost', label: 'Ghost (never answers)', canAnswer: () => false },
]);

export { dayNumber, dayString };
