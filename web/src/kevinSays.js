// Everything Kevin says, as pure functions over plain chain data (stats, tickets, a desk, a clock).
// The jokes are fixed copy; every number, CVE id, product and date in them comes from the arguments.
// Kevin talks in the first person: sincere, proud of his emails, and sure the pager likes him.
// Each list of rules is checked top down and the first true rule wins.
import { countdown, countdownWords, fmtInt, fmtToken } from './format.js';
import { monthName, monthOf } from './roster.js';

const DAY = 86_400_000;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
// "Recently" for the status board's event line: a day on the live desk, half an hour on the fire drill.
export const RECENT_MS = { live: DAY, drill: 30 * 60_000 };
export const NEW_TICKET_MS = 2 * DAY;

const num = (x) => Number(x ?? 0) || 0;
const big = (x) => {
  try {
    return BigInt(x ?? 0);
  } catch {
    return 0n;
  }
};
const count = (n, one, many) => `${fmtInt(n)} ${n === 1 ? one : many}`;

export const isExpired = (t, now) => t.state === 'expired' || num(t.deadline_ms) <= now;
export const isOpen = (t, now) => !isExpired(t, now);
const dueWithinDay = (t, now) => isOpen(t, now) && num(t.deadline_ms) - now < DAY;
const byDeadline = (a, b) => num(a.deadline_ms) - num(b.deadline_ms);
const monthDay = (ms) => {
  const d = new Date(num(ms));
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
};

// ---------- status board ----------

export const QUOTES = {
  nobodyOnCall: "Nobody's on call. The pager keeps ringing anyway. I think it's lonely.",
  ignored: (opened) =>
    opened === 1
      ? 'Per my last email, which was also my best email...'
      : `Per my last ${fmtInt(opened)} emails, which were also my best ${fmtInt(opened)} emails...`,
  open: (opened) => `I've sent ${count(opened, 'email', 'emails')}. I can see you've read them. That's almost a reply.`,
  inboxZero: "Inbox zero. I don't trust it.",
};

export function headline({ tickets, now }) {
  const open = tickets.filter((t) => isOpen(t, now));
  const soon = open.filter((t) => dueWithinDay(t, now));
  if (soon.length) return `${count(soon.length, 'ticket', 'tickets')} due in under 24 hours`;
  if (open.length) return `${count(open.length, 'ticket', 'tickets')} open`;
  return 'No open tickets';
}

export function quote({ stats, tickets, now }) {
  const opened = num(stats?.tickets_opened);
  if (num(stats?.on_call) === 0) return QUOTES.nobodyOnCall;
  const ignored = tickets.filter((t) => isExpired(t, now)).reduce((s, t) => s + num(t.missed), 0);
  if (ignored > 0) return QUOTES.ignored(opened);
  if (tickets.some((t) => isOpen(t, now))) return QUOTES.open(opened);
  return QUOTES.inboxZero;
}

// True while some on-call desk still carries a burn the chain has not settled, or the roster has not
// been read yet, or its last read failed (a desk far behind is exactly what makes that read fail).
// Until then a ticket's `missed: 0` does not mean everyone answered.
export const rosterUnsettled = (roster) =>
  !roster?.loaded || Boolean(roster.error) || roster.entries.some((e) => e.desk?.on_call && big(e.desk.pending_burn) > 0n);

// `unsettled` is true when some on-call desk still has a miss the chain has not settled yet. A
// ticket's `missed` counts settled misses only, so "everyone answered" waits until that is false.
export function eventLine({ stats, tickets, now, kind = 'live', unsettled = false }) {
  const window = RECENT_MS[kind] ?? RECENT_MS.live;
  const recent = tickets
    .filter((t) => isExpired(t, now) && now - num(t.deadline_ms) < window)
    .sort((a, b) => byDeadline(b, a));
  const ignored = recent.find((t) => num(t.missed) > 0);
  if (ignored) {
    // settled misses only: while other desks are still waiting to be settled, these are lower bounds
    return unsettled
      ? `At least ${count(num(ignored.missed), 'on-call desk', 'on-call desks')} ignored ${ignored.cve_id} (${ignored.product}). I've burned ${fmtToken(ignored.burned)} KEVIN so far. It was in the email.`
      : `${count(num(ignored.missed), 'on-call desk', 'on-call desks')} ignored ${ignored.cve_id} (${ignored.product}). I burned ${fmtToken(ignored.burned)} KEVIN. It was in the email.`;
  }
  const clean = !unsettled && recent.find((t) => num(t.missed) === 0 && num(t.closes) > 0);
  if (clean) return `Everyone on call answered ${clean.cve_id} before the deadline. I don't have a template for this. I'm making one.`;
  const open = tickets.filter((t) => isOpen(t, now)).sort(byDeadline);
  const ransom = open.find((t) => t.ransomware);
  if (ransom) {
    return `Ransomware crews are using ${ransom.cve_id} (${ransom.vendor} ${ransom.product}). I asked humanity to patch it. Humanity is "looking into it", which is nice of them.`;
  }
  const fresh = tickets
    .filter((t) => num(t.opened_at_ms) <= now && now - num(t.opened_at_ms) < NEW_TICKET_MS)
    .sort((a, b) => num(b.opened_at_ms) - num(a.opened_at_ms))[0];
  if (fresh) return `New from CISA: ${fresh.vendor} ${fresh.product}. I've asked humanity to restart its router. Humanity has declined.`;
  return `${fmtInt(open.length)} open, ${count(num(stats?.on_call), 'desk', 'desks')} on call, ${fmtToken(stats?.burned_total)} KEVIN burned so far. I'm fine. This is fine.`;
}

// The soonest open deadline, or null when nothing is open.
export function nextDeadline({ tickets, now }) {
  const t = tickets.filter((x) => isOpen(x, now)).sort(byDeadline)[0];
  if (!t) return null;
  const c = countdown(t.deadline_ms, now);
  return {
    ticket: t,
    text: `Next deadline: ${monthDay(t.deadline_ms)}, ${t.cve_id} (${c.text})`,
    spoken: `Next deadline: ${monthDay(t.deadline_ms)}, ${t.cve_id}, ${countdownWords(t.deadline_ms, now)}`,
  };
}

export function statusBoard(args) {
  const a = { tickets: [], kind: 'live', ...args };
  return { label: 'KEVIN FROM IT', headline: headline(a), quote: quote(a), event: eventLine(a), next: nextDeadline(a) };
}

// ---------- one note per ticket ----------

export const TICKET_ROTATION = [
  'Have you tried turning it off and patching it?',
  'CISA opened this ticket, not me. I just work here.',
  'Somebody marked this "low priority". It wasn\'t me. I\'d never.',
  "Please don't reply-all. Last time was a long week.",
];

// `unsettled` as in eventLine: while some on-call desk still has a miss waiting to be settled, an
// expired ticket with `missed: 0` is not yet proof that everyone answered.
export function ticketNote(t, now, { unsettled = false } = {}) {
  if (isExpired(t, now)) {
    if (num(t.missed) > 0) return `Closed by the clock. ${fmtInt(t.missed)} didn't answer. I've updated the spreadsheet. It's a good spreadsheet.`;
    return unsettled ? "Closed by the clock. I'm still counting who answered. I count slow, but I count right." : 'Closed by the clock. Everyone answered. Suspicious.';
  }
  if (t.ransomware) return `Ransomware crews use this one, so it's ${num(t.burn_bps) / 100}%. I don't make the rules. I do enforce them. That's the fun part.`;
  if (num(t.deadline_ms) - now < DAY) return "Due soon. I put it in bold. I put it in red. I put it in your calendar. Then I ran out of places.";
  if (num(t.closes) === 0) return "No replies yet. I can see you've opened it.";
  return TICKET_ROTATION[num(t.id) % 4];
}

// ---------- my desk ----------

export const DESK_LINES = {
  noDesk: "You don't have a desk. Honestly, well done.",
  holder: 'You hold KEVIN. Nothing is expected of you. Nothing will burn. I envy you.',
  queue: (n) =>
    `You've got ${count(n, 'ticket', 'tickets')} in your queue. I emailed you about ${n === 1 ? 'it' : 'each one'}. ${n === 1 ? "It's one of my best emails." : "They're some of my best emails."}`,
  clear: 'Queue is clear. Go home. Keep the pager on.',
  pendingBurn: (cve, amount) =>
    `You missed ${cve}. I'm burning ${fmtToken(amount)} KEVIN of what you committed. It isn't personal. It's in the contract.`,
  clockOutRefused: "You can't clock out with tickets in your queue. Nobody can. I've tried.",
  behind: (n) => `Your desk has ${count(n, 'expired ticket', 'expired tickets')} to settle. Settle first, then clock out.`,
  shiftRefused: (endsMs) => `Your shift ends ${whenText(endsMs)}. You took the pager. The pager doesn't care. I care a little.`,
};

// "November 21, 18:04 UTC"
export const whenText = (ms) => `${monthDay(ms)}, ${new Date(num(ms)).toISOString().slice(11, 16)} UTC`;
export const shiftEndsText = (ms) => `Shift ends ${whenText(ms)}`;

// "7 days", "30 minutes", "1 hour 30 minutes": the contract's min_shift_ms in words.
export function durationWords(ms) {
  let left = Math.max(0, Math.round(num(ms) / 60_000));
  const parts = [];
  for (const [size, one, many] of [
    [1440, 'day', 'days'],
    [60, 'hour', 'hours'],
    [1, 'minute', 'minutes'],
  ]) {
    const n = Math.floor(left / size);
    if (n) parts.push(count(n, one, many));
    left -= n * size;
  }
  return parts.join(' ') || 'under a minute';
}
export const minShiftText = (ms) => `A shift is at least ${durationWords(ms)}.`;

// Why clock_out would be refused right now, in the contract's own order (behind, shift, then open
// tickets), or null when it would go through. clock_out settles up to 50 expired tickets itself; a desk
// further behind than that is refused until someone calls settle for it.
export const SETTLE_INLINE = 50;
export function clockOutBlock({ desk, tickets, statements, now }) {
  if (!desk?.on_call) return null;
  if (num(desk.unsettled) > SETTLE_INLINE) return { reason: 'behind', line: DESK_LINES.behind(num(desk.unsettled)) };
  const ends = num(desk.shift_ends_ms);
  if (ends && now < ends) return { reason: 'shift', line: DESK_LINES.shiftRefused(ends) };
  const left = unansweredOpen({ tickets, statements, now });
  if (left.length) return { reason: 'queue', line: DESK_LINES.clockOutRefused, tickets: left };
  return null;
}

export const ACTION_LINES = {
  answered: "Noted. That's one more reply than most people send. I'm telling everyone.",
  onCall: "Welcome to the rota. The pager's yours. It doesn't have an off switch. I looked.",
  clockedOut: "Pager returned. Tokens returned. I'm still here. I'm always here.",
};

// Open tickets this desk has not answered: what blocks clock_out, and the queue count.
export const unansweredOpen = ({ tickets, statements, now }) =>
  tickets.filter((t) => isOpen(t, now) && !statements?.[t.id]).sort(byDeadline);

// How this desk stands on one expired ticket. It missed the ticket for certain only when its current
// stint (`on_call_since_ms`) started before the deadline. A ticket that expired before this stint, or
// while the desk is clocked out, gets no verdict: the desk may or may not have been on call then.
export function deskVerdict(desk, t, statement) {
  if (statement) return 'answered';
  const first = num(desk?.first_on_call_ms);
  const deadline = num(t.deadline_ms);
  if (!desk?.registered || !first || first >= deadline) return 'not_on_call';
  return desk.on_call && num(desk.on_call_since_ms) < deadline ? 'missed' : 'no_answer';
}

// The ticket a pending burn is for: the latest expired one this on-call desk left silent.
export function lastMissed({ desk, tickets, statements, now }) {
  return tickets
    .filter((t) => isExpired(t, now) && deskVerdict(desk, t, statements?.[t.id]) === 'missed')
    .sort((a, b) => byDeadline(b, a))[0] || null;
}

export function deskLine({ desk, tickets = [], statements = {}, now }) {
  if (!desk?.registered) return DESK_LINES.noDesk;
  if (!desk.on_call) return DESK_LINES.holder;
  if (big(desk.pending_burn) > 0n) {
    const t = lastMissed({ desk, tickets, statements, now });
    return DESK_LINES.pendingBurn(t ? t.cve_id : 'a deadline', desk.pending_burn);
  }
  const n = unansweredOpen({ tickets, statements, now }).length;
  return n ? DESK_LINES.queue(n) : DESK_LINES.clear;
}

// ---------- employee of the month ----------

export const EOTM = {
  heading: (now) => `Employee of the Month: ${monthName(monthOf(now))}`,
  note: 'Answers are self-reported. A clicked "Fixed" proves a desk answered before CISA\'s deadline. It does not prove anything was patched.',
  empty: "Nobody's taken the pager yet. The plaque is still in its bubble wrap. I haven't popped any. Okay, I popped one.",
};
