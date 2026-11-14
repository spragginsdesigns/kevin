import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTION_LINES,
  DESK_LINES,
  EOTM,
  TICKET_ROTATION,
  clockOutBlock,
  deskLine,
  deskVerdict,
  durationWords,
  eventLine,
  headline,
  minShiftText,
  nextDeadline,
  quote,
  rosterUnsettled,
  shiftEndsText,
  statusBoard,
  ticketNote,
  unansweredOpen,
} from './kevinSays.js';
import { explainError } from './errors.js';

const H = 3_600_000;
const DAY = 24 * H;
const NOW = Date.parse('2026-11-14T12:00:00Z');
const K = 10n ** 18n;

let nextId = 0;
// A ticket as get_tickets returns it; `deadline` and `opened` are offsets from NOW.
function ticket({ deadline = 5 * DAY, opened = -5 * DAY, ...o } = {}) {
  const id = o.id ?? nextId++;
  return {
    id,
    cve_id: o.cve_id || `CVE-2026-${1000 + id}`,
    vendor: o.vendor || 'Acme',
    product: o.product || `Widget ${id}`,
    ransomware: false,
    burn_bps: o.ransomware ? 500 : 100,
    opened_at_ms: String(NOW + opened),
    deadline_ms: String(NOW + deadline),
    state: deadline <= 0 ? 'expired' : 'open',
    closes: 0,
    missed: 0,
    burned: '0',
    ...o,
  };
}
const stats = (o = {}) => ({ tickets_opened: 40, on_call: 3, burned_total: (1234n * K).toString(), ...o });

// ---------- headline ----------

test('headline 1: tickets due in under 24 hours win', () => {
  const tickets = [ticket({ deadline: 2 * H }), ticket({ deadline: 23 * H }), ticket({ deadline: 3 * DAY })];
  assert.equal(headline({ tickets, now: NOW }), '2 tickets due in under 24 hours');
  assert.equal(headline({ tickets: [ticket({ deadline: H })], now: NOW }), '1 ticket due in under 24 hours');
});

test('headline 2: open tickets when none is due within a day', () => {
  const tickets = [ticket({ deadline: 24 * H }), ticket({ deadline: 3 * DAY }), ticket({ deadline: -H })];
  assert.equal(headline({ tickets, now: NOW }), '2 tickets open');
  assert.equal(headline({ tickets: [ticket({ deadline: 2 * DAY })], now: NOW }), '1 ticket open');
});

test('headline 3: no open tickets (expired ones do not count, nor a ticket whose deadline just passed)', () => {
  const lapsing = { ...ticket({ deadline: 2 * H }), deadline_ms: String(NOW - 1), state: 'open' };
  assert.equal(headline({ tickets: [ticket({ deadline: -DAY }), lapsing], now: NOW }), 'No open tickets');
  assert.equal(headline({ tickets: [], now: NOW }), 'No open tickets');
});

// ---------- quote ----------

test('quote 1: nobody on call beats everything', () => {
  const tickets = [ticket({ deadline: -H, missed: 4 }), ticket()];
  assert.equal(quote({ stats: stats({ on_call: 0 }), tickets, now: NOW }), "Nobody's on call. The pager keeps ringing anyway. I think it's lonely.");
});

test('quote 2: an ignored ticket beats open tickets', () => {
  const tickets = [ticket({ deadline: -10 * DAY, missed: 1 }), ticket()];
  assert.equal(quote({ stats: stats(), tickets, now: NOW }), 'Per my last 40 emails, which were also my best 40 emails...');
  assert.equal(quote({ stats: stats({ tickets_opened: 1 }), tickets, now: NOW }), 'Per my last email, which was also my best email...');
  assert.equal(quote({ stats: stats({ tickets_opened: 1234 }), tickets, now: NOW }), 'Per my last 1,234 emails, which were also my best 1,234 emails...');
});

test('quote 3: open tickets, nothing ignored', () => {
  const tickets = [ticket({ deadline: -DAY, missed: 0, closes: 3 }), ticket()];
  assert.equal(quote({ stats: stats(), tickets, now: NOW }), "I've sent 40 emails. I can see you've read them. That's almost a reply.");
});

test('quote 4: inbox zero', () => {
  assert.equal(quote({ stats: stats(), tickets: [ticket({ deadline: -DAY })], now: NOW }), "Inbox zero. I don't trust it.");
});

// ---------- event line ----------

const missedRecent = () => ticket({ deadline: -3 * H, missed: 2, closes: 4, burned: (55n * K).toString(), cve_id: 'CVE-2026-1', product: 'VPN' });
const cleanRecent = () => ticket({ deadline: -2 * H, missed: 0, closes: 5, cve_id: 'CVE-2026-2' });
const ransomOpen = () => ticket({ deadline: 3 * DAY, ransomware: true, cve_id: 'CVE-2026-3', vendor: 'Broadcom', product: 'VMware vCenter' });
const freshOpen = () => ticket({ deadline: 9 * DAY, opened: -20 * H, vendor: 'Cisco', product: 'BroadWorks' });

test('event 1: a recent ticket on-call desks missed (the most recent such ticket)', () => {
  const older = ticket({ deadline: -20 * H, missed: 1, burned: '0', cve_id: 'CVE-2026-9', product: 'Old' });
  const tickets = [older, missedRecent(), cleanRecent(), ransomOpen(), freshOpen()];
  assert.equal(
    eventLine({ stats: stats(), tickets, now: NOW }),
    '2 on-call desks ignored CVE-2026-1 (VPN). I burned 55 KEVIN. It was in the email.',
  );
  const one = ticket({ deadline: -H, missed: 1, burned: (2n * K).toString(), cve_id: 'CVE-2026-4', product: 'Mail' });
  assert.equal(eventLine({ stats: stats(), tickets: [one], now: NOW }), '1 on-call desk ignored CVE-2026-4 (Mail). I burned 2 KEVIN. It was in the email.');
});

test('event 1 respects "recently": 24 hours live, 30 minutes on the fire drill', () => {
  const t = ticket({ deadline: -25 * H, missed: 3, product: 'X' });
  assert.doesNotMatch(eventLine({ stats: stats(), tickets: [t], now: NOW }), /ignored/);
  const d = ticket({ deadline: -20 * 60_000, missed: 1, product: 'Y', cve_id: 'CVE-2021-44228' });
  assert.match(eventLine({ stats: stats(), tickets: [d], now: NOW, kind: 'drill' }), /^1 on-call desk ignored CVE-2021-44228/);
  const late = ticket({ deadline: -31 * 60_000, missed: 1, product: 'Z' });
  assert.doesNotMatch(eventLine({ stats: stats(), tickets: [late], now: NOW, kind: 'drill' }), /ignored/);
});

test('event 2: everyone on call answered a recent ticket', () => {
  const tickets = [cleanRecent(), ransomOpen(), freshOpen()];
  assert.equal(
    eventLine({ stats: stats(), tickets, now: NOW }),
    "Everyone on call answered CVE-2026-2 before the deadline. I don't have a template for this. I'm making one.",
  );
});

test('event 2 needs at least one answer, and waits while misses are unsettled', () => {
  const nobody = ticket({ deadline: -H, missed: 0, closes: 0 });
  assert.doesNotMatch(eventLine({ stats: stats(), tickets: [nobody], now: NOW }), /Everyone/);
  assert.doesNotMatch(eventLine({ stats: stats(), tickets: [cleanRecent()], now: NOW, unsettled: true }), /Everyone/);
});

test('event 3: an open ransomware ticket', () => {
  const tickets = [ransomOpen(), freshOpen()];
  assert.equal(
    eventLine({ stats: stats(), tickets, now: NOW }),
    'Ransomware crews are using CVE-2026-3 (Broadcom VMware vCenter). I asked humanity to patch it. Humanity is "looking into it", which is nice of them.',
  );
});

test('event 4: a ticket opened in the last 48 hours (the newest one)', () => {
  const older = ticket({ deadline: 9 * DAY, opened: -40 * H, vendor: 'Old', product: 'Thing' });
  assert.equal(
    eventLine({ stats: stats(), tickets: [older, freshOpen()], now: NOW }),
    "New from CISA: Cisco BroadWorks. I've asked humanity to restart its router. Humanity has declined.",
  );
  const stale = ticket({ deadline: 9 * DAY, opened: -49 * H });
  assert.doesNotMatch(eventLine({ stats: stats(), tickets: [stale], now: NOW }), /New from CISA/);
});

test('event 5: the summary line', () => {
  const tickets = [ticket({ deadline: 9 * DAY, opened: -5 * DAY }), ticket({ deadline: -3 * DAY })];
  assert.equal(
    eventLine({ stats: stats({ on_call: 1 }), tickets, now: NOW }),
    "1 open, 1 desk on call, 1,234 KEVIN burned so far. I'm fine. This is fine.",
  );
  assert.equal(
    eventLine({ stats: stats({ on_call: 0, burned_total: '0' }), tickets: [], now: NOW }),
    "0 open, 0 desks on call, 0 KEVIN burned so far. I'm fine. This is fine.",
  );
});

test('next deadline: soonest open ticket, month and day in UTC, ticking countdown; null when none', () => {
  const soon = ticket({ deadline: 2 * DAY + 3 * H + 4 * 60_000 + 5_000, cve_id: 'CVE-2026-77' });
  const n = nextDeadline({ tickets: [ticket({ deadline: 6 * DAY }), soon, ticket({ deadline: -H })], now: NOW });
  assert.equal(n.text, 'Next deadline: November 16, CVE-2026-77 (2d 03:04:05)');
  assert.match(n.spoken, /2 days 3 hours left$/);
  assert.equal(nextDeadline({ tickets: [ticket({ deadline: -H })], now: NOW }), null);
});

test('statusBoard puts the pieces together', () => {
  const b = statusBoard({ stats: stats(), tickets: [missedRecent(), ticket({ deadline: 5 * H })], now: NOW });
  assert.equal(b.label, 'KEVIN FROM IT');
  assert.equal(b.headline, '1 ticket due in under 24 hours');
  assert.equal(b.quote, 'Per my last 40 emails, which were also my best 40 emails...');
  assert.match(b.event, /ignored CVE-2026-1/);
  assert.match(b.next.text, /^Next deadline: November 14, /);
});

// ---------- ticket notes ----------

test('ticket note 1 and 2: expired tickets, by settled misses', () => {
  assert.equal(ticketNote(ticket({ deadline: -H, missed: 3 }), NOW), "Closed by the clock. 3 didn't answer. I've updated the spreadsheet. It's a good spreadsheet.");
  assert.equal(ticketNote(ticket({ deadline: -H, missed: 0, ransomware: true }), NOW), 'Closed by the clock. Everyone answered. Suspicious.');
  assert.equal(ticketNote(ticket({ deadline: -H, missed: 0 }), NOW, { unsettled: true }), "Closed by the clock. I'm still counting who answered. I count slow, but I count right.");
  assert.equal(ticketNote(ticket({ deadline: -H, missed: 2 }), NOW, { unsettled: true }), "Closed by the clock. 2 didn't answer. I've updated the spreadsheet. It's a good spreadsheet.");
});

test('ticket note 3: ransomware beats due-soon and no-replies, and states the chain rate', () => {
  const t = ticket({ deadline: 2 * H, ransomware: true, closes: 0 });
  assert.equal(ticketNote(t, NOW), "Ransomware crews use this one, so it's 5%. I don't make the rules. I do enforce them. That's the fun part.");
});

test('ticket note 4: due in under 24 hours beats no-replies', () => {
  assert.equal(
    ticketNote(ticket({ deadline: 23 * H, closes: 0 }), NOW),
    "Due soon. I put it in bold. I put it in red. I put it in your calendar. Then I ran out of places.",
  );
});

test('ticket note 5: no replies yet', () => {
  assert.equal(ticketNote(ticket({ deadline: 3 * DAY, closes: 0 }), NOW), "No replies yet. I can see you've opened it.");
});

test('ticket note 6: rotation by id % 4', () => {
  for (let id = 0; id < 8; id++) assert.equal(ticketNote(ticket({ id, deadline: 3 * DAY, closes: 2 }), NOW), TICKET_ROTATION[id % 4]);
  assert.equal(TICKET_ROTATION.length, 4);
  assert.equal(TICKET_ROTATION[2], 'Somebody marked this "low priority". It wasn\'t me. I\'d never.');
});

// ---------- my desk ----------

const onCall = (o = {}) => ({
  registered: true,
  on_call: true,
  balance: (5000n * K).toString(),
  committed: (5000n * K).toString(),
  pending_burn: '0',
  first_on_call_ms: String(NOW - 10 * DAY),
  on_call_since_ms: String(NOW - 10 * DAY),
  shift_ends_ms: String(NOW - DAY),
  ...o,
});

test('desk line: no desk', () => {
  assert.equal(deskLine({ desk: null, now: NOW }), "You don't have a desk. Honestly, well done.");
  assert.equal(deskLine({ desk: { registered: false }, now: NOW }), DESK_LINES.noDesk);
});

test('desk line: a holder not on call (even with a pending burn field or open tickets)', () => {
  const desk = { registered: true, on_call: false, pending_burn: '5' };
  assert.equal(deskLine({ desk, tickets: [ticket()], now: NOW }), 'You hold KEVIN. Nothing is expected of you. Nothing will burn. I envy you.');
});

test('desk line: a pending burn beats the queue count, and names the latest silent CVE', () => {
  const missedOld = ticket({ deadline: -5 * DAY, cve_id: 'CVE-2026-10' });
  const missedNew = ticket({ deadline: -H, cve_id: 'CVE-2026-11' });
  const answered = ticket({ deadline: -30 * 60_000, cve_id: 'CVE-2026-12' });
  const tickets = [missedOld, missedNew, answered, ticket()];
  const desk = onCall({ pending_burn: (50n * K).toString() });
  assert.equal(
    deskLine({ desk, tickets, statements: { [answered.id]: { status: 'fixed' } }, now: NOW }),
    "You missed CVE-2026-11. I'm burning 50 KEVIN of what you committed. It isn't personal. It's in the contract.",
  );
});

test('desk line: n unanswered open tickets', () => {
  const a = ticket();
  const b = ticket();
  const c = ticket();
  assert.equal(
    deskLine({ desk: onCall(), tickets: [a, b, c], statements: { [a.id]: { status: 'fixed' } }, now: NOW }),
    "You've got 2 tickets in your queue. I emailed you about each one. They're some of my best emails.",
  );
  assert.equal(deskLine({ desk: onCall(), tickets: [a], now: NOW }), "You've got 1 ticket in your queue. I emailed you about it. It's one of my best emails.");
});

test('desk line: queue clear', () => {
  const a = ticket();
  assert.equal(deskLine({ desk: onCall(), tickets: [a, ticket({ deadline: -H })], statements: { [a.id]: { status: 'mitigated' } }, now: NOW }), 'Queue is clear. Go home. Keep the pager on.');
});

test('action lines are the spec copy', () => {
  assert.equal(ACTION_LINES.answered, "Noted. That's one more reply than most people send. I'm telling everyone.");
  assert.equal(ACTION_LINES.onCall, "Welcome to the rota. The pager's yours. It doesn't have an off switch. I looked.");
  assert.equal(ACTION_LINES.clockedOut, "Pager returned. Tokens returned. I'm still here. I'm always here.");
});

// ---------- shift and clock out ----------

test('shift copy: end time and minimum shift in plain words', () => {
  const ends = Date.parse('2026-11-21T18:04:30Z');
  assert.equal(shiftEndsText(ends), 'Shift ends November 21, 18:04 UTC');
  assert.equal(DESK_LINES.shiftRefused(ends), "Your shift ends November 21, 18:04 UTC. You took the pager. The pager doesn't care. I care a little.");
  assert.equal(minShiftText('604800000'), 'A shift is at least 7 days.');
  assert.equal(minShiftText('1800000'), 'A shift is at least 30 minutes.');
  assert.equal(durationWords(DAY), '1 day');
  assert.equal(durationWords(90 * 60_000), '1 hour 30 minutes');
});

test('clock out: not on call means nothing to refuse', () => {
  assert.equal(clockOutBlock({ desk: { registered: true, on_call: false }, tickets: [ticket()], now: NOW }), null);
});

test('clock out: the shift is checked before the queue (contract order)', () => {
  const desk = onCall({ shift_ends_ms: String(NOW + 2 * DAY) });
  const b = clockOutBlock({ desk, tickets: [ticket()], statements: {}, now: NOW });
  assert.equal(b.reason, 'shift');
  assert.match(b.line, /^Your shift ends November 16, 12:00 UTC\./);
  // allowed at exactly the end of the shift
  const atEnd = clockOutBlock({ desk: onCall({ shift_ends_ms: String(NOW) }), tickets: [], now: NOW });
  assert.equal(atEnd, null);
});

test('clock out: unanswered open tickets refuse with Kevin\'s line and list the tickets', () => {
  const a = ticket({ deadline: 2 * DAY, cve_id: 'CVE-2026-50' });
  const b = ticket({ deadline: DAY, cve_id: 'CVE-2026-51' });
  const r = clockOutBlock({ desk: onCall(), tickets: [a, b, ticket({ deadline: -H })], statements: {}, now: NOW });
  assert.equal(r.reason, 'queue');
  assert.equal(r.line, "You can't clock out with tickets in your queue. Nobody can. I've tried.");
  assert.deepEqual(r.tickets.map((t) => t.cve_id), ['CVE-2026-51', 'CVE-2026-50']);
  assert.equal(clockOutBlock({ desk: onCall(), tickets: [a, b], statements: { [a.id]: {}, [b.id]: {} }, now: NOW }), null);
});

test('clockOutBlock: a desk more than 50 expired tickets behind has to settle first', () => {
  const r = clockOutBlock({ desk: onCall({ unsettled: 51 }), tickets: [], statements: {}, now: NOW });
  assert.equal(r.reason, 'behind');
  assert.equal(r.line, 'Your desk has 51 expired tickets to settle. Settle first, then clock out.');
  assert.equal(clockOutBlock({ desk: onCall({ unsettled: 50 }), tickets: [], statements: {}, now: NOW }), null);
});

test('eventLine: the ignored line says "at least" while other desks are still unsettled', () => {
  const t = ticket({ deadline: -H, missed: 2, burned: (375n * K).toString(), cve_id: 'CVE-2021-44228', product: 'Log4j2' });
  assert.equal(
    eventLine({ stats: { on_call: 4 }, tickets: [t], now: NOW, unsettled: true }),
    "At least 2 on-call desks ignored CVE-2021-44228 (Log4j2). I've burned 375 KEVIN so far. It was in the email.",
  );
  assert.equal(
    eventLine({ stats: { on_call: 4 }, tickets: [t], now: NOW, unsettled: false }),
    '2 on-call desks ignored CVE-2021-44228 (Log4j2). I burned 375 KEVIN. It was in the email.',
  );
});

test('unansweredOpen ignores expired tickets', () => {
  assert.equal(unansweredOpen({ tickets: [ticket({ deadline: -H }), ticket()], statements: {}, now: NOW }).length, 1);
});

test('deskVerdict: liable only when on call before the deadline', () => {
  const t = ticket({ deadline: -H });
  assert.equal(deskVerdict(onCall(), t, { status: 'fixed' }), 'answered');
  assert.equal(deskVerdict(onCall(), t, null), 'missed');
  assert.equal(deskVerdict(onCall({ first_on_call_ms: String(NOW) }), t, null), 'not_on_call');
  assert.equal(deskVerdict({ registered: true, on_call: false, first_on_call_ms: '0' }, t, null), 'not_on_call');
  assert.equal(deskVerdict(onCall({ on_call: false }), t, null), 'no_answer');
  // clocked out and came back after this ticket expired: no verdict, it may not have been on call then
  assert.equal(deskVerdict(onCall({ on_call_since_ms: String(NOW) }), t, null), 'no_answer');
  assert.equal(deskVerdict(null, t, null), 'not_on_call');
});

// ---------- panics in plain words ----------

test('contract panics map to Kevin lines or plain sentences', () => {
  const p = (m) => new Error(`Smart contract panicked: ${m}`);
  assert.equal(explainError(p('answer every open ticket before you clock out')), DESK_LINES.clockOutRefused);
  assert.match(explainError(p('your shift is not over')), /shift is not over/);
  assert.match(explainError(p('go on call first: go_on_call')), /Take the pager first/);
  assert.match(explainError(p('not enough free balance: committed tokens cannot move')), /Committed tokens cannot move/);
  assert.match(explainError(p('not enough free balance')), /free KEVIN/);
  assert.match(explainError(p('commit at least the minimum to go on call')), /minimum/);
  assert.equal(explainError(p('something new')), 'The contract refused: something new.');
});

// ---------- employee of the month copy ----------

test('employee of the month copy', () => {
  assert.equal(EOTM.heading(NOW), 'Employee of the Month: November 2026');
  assert.equal(EOTM.heading(Date.parse('2026-12-01T00:00:00Z')), 'Employee of the Month: December 2026');
  assert.equal(EOTM.note, 'Answers are self-reported. A clicked "Fixed" proves a desk answered before CISA\'s deadline. It does not prove anything was patched.');
  assert.equal(EOTM.empty, "Nobody's taken the pager yet. The plaque is still in its bubble wrap. I haven't popped any. Okay, I popped one.");
});

test('no line uses an em dash or other non-ASCII punctuation', () => {
  const lines = [
    ...Object.values(ACTION_LINES),
    ...Object.values(DESK_LINES).filter((x) => typeof x === 'string'),
    ...TICKET_ROTATION,
    EOTM.note,
    EOTM.empty,
  ];
  for (const l of lines) assert.match(l, /^[\x20-\x7e]+$/, l);
});

test('rosterUnsettled: true until the roster is read and no on-call desk carries a pending burn', () => {
  assert.equal(rosterUnsettled(null), true);
  assert.equal(rosterUnsettled({ loaded: false, entries: [] }), true);
  assert.equal(rosterUnsettled({ loaded: true, entries: [] }), false);
  assert.equal(rosterUnsettled({ loaded: true, entries: [], error: 'RPC is rate limiting' }), true);
  assert.equal(rosterUnsettled({ loaded: true, entries: [{ desk: { on_call: true, pending_burn: '0' } }] }), false);
  assert.equal(rosterUnsettled({ loaded: true, entries: [{ desk: { on_call: true, pending_burn: '5' } }] }), true);
  assert.equal(rosterUnsettled({ loaded: true, entries: [{ desk: { on_call: false, pending_burn: '5' } }] }), false);
});
