// In-memory implementation of the KEVIN v2 contract ABI, selected with ?mock=1. It follows the spec's
// rules exactly: free balances never burn; go_on_call commits tokens (minimum, top-up settles first);
// only on-call desks answer; settlement walks the expired order from each desk's cursor and burns
// floor(committed * bps / 10000) per miss; clock_out needs a settled desk, a finished shift and every
// open ticket answered; the roster and the monthly (UTC) counters follow get_roster / get_desk.
// Tickets are real CISA KEV entries; their deadlines are set relative to now (live desk) or on a fast
// clock (fire drill) so the page always has a queue to show. The seeded desks are simulated accounts.
//   ?fail=rpc     every view fails like an RPC outage
//   ?fail=roster  get_roster fails like an RPC outage
//   ?fail=faucet  the first guest account request is rate limited
//   ?roster=0     nobody has ever taken the pager (empty roster)
import { KeyPair } from 'near-api-js';
import recent from 'virtual:kev-recent';
import { loadGuest, saveGuest, clearGuest, randomGuestId } from './guest.js';
import { monthOf } from './roster.js';

const TOKEN = 10n ** 18n;
const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const MAX_WINDOW_MS = 200 * DAY;
const SETTLE_LIMIT = 50;
const ROSTER_MAX = 50;
const NETWORK = 'mock-testnet';
const STATUSES = ['not_affected', 'fixed', 'mitigated'];

class Panic extends Error {
  constructor(msg) {
    super(`Smart contract panicked: ${msg}`);
    this.panic = msg;
  }
}
const panic = (msg) => {
  throw new Panic(msg);
};

function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CVE_RE = /^CVE-\d{4}-\d+$/;
const utf8len = (s) => new TextEncoder().encode(s).length;

// Real KEV entries replayed on the drill desk, all present in the committed snapshot.
const DRILL_CVES = [
  'CVE-2021-44228',
  'CVE-2023-4966',
  'CVE-2024-3400',
  'CVE-2023-34362',
  'CVE-2023-20198',
  'CVE-2024-1709',
  'CVE-2023-0669',
  'CVE-2022-47966',
  'CVE-2021-26855',
  'CVE-2021-34527',
];

function newDesk(now) {
  return {
    cursor: 0,
    on_call: false,
    committed: 0n,
    on_call_since_ms: 0,
    first_on_call_ms: 0,
    on_time: 0,
    missed: 0,
    streak: 0,
    best_streak: 0,
    burned: 0n,
    month: 0,
    month_on_time: 0,
    month_missed: 0,
    month_burned: 0n,
    claimed_starter: false,
    registered_at_ms: now,
  };
}

class Ledger {
  constructor(contractId, cfg) {
    this.contractId = contractId;
    this.config = cfg;
    this.balances = new Map([[contractId, BigInt(cfg.initial_supply)]]); // free balances
    this.desks = new Map();
    this.tickets = [];
    this.byCve = new Map();
    this.open = [];
    this.expired = [];
    this.statements = new Map();
    this.pending = new Map(); // report hash -> Set(reporters)
    this.totalSupply = BigInt(cfg.initial_supply);
    this.burnedTotal = 0n;
    this.statementsTotal = 0;
    this.roster = [];
    this.committedTotal = 0n;
    this.missesTotal = 0;
    this.events = [];
  }

  // ----- internals -----
  emit(event, data) {
    this.events.push({ standard: event.startsWith('ft_') ? 'nep141' : 'kevin', version: event.startsWith('ft_') ? '1.0.0' : '2.0.0', event, data });
    if (this.events.length > 200) this.events.shift();
  }
  bal(a) {
    return this.balances.get(a) || 0n;
  }
  desk(a) {
    return this.desks.get(a);
  }
  mustDesk(a) {
    const d = this.desk(a);
    if (!d) panic('register first: storage_deposit');
    return d;
  }
  // The one helper for the monthly counters (spec: a newer month resets them, an older event only
  // changes the lifetime counters).
  applyMonth(d, eventMonth, kind, burn = 0n) {
    if (eventMonth > d.month) {
      d.month = eventMonth;
      d.month_on_time = 0;
      d.month_missed = 0;
      d.month_burned = 0n;
    }
    if (eventMonth === d.month) {
      if (kind === 'on_time') d.month_on_time += 1;
      else {
        d.month_missed += 1;
        d.month_burned += burn;
      }
    }
  }
  runExpiry(now) {
    const due = this.open
      .map((id) => this.tickets[id])
      .filter((t) => now >= t.deadline_ms)
      .sort((a, b) => a.deadline_ms - b.deadline_ms || a.id - b.id);
    for (const t of due) {
      this.open = this.open.filter((id) => id !== t.id);
      t.state = 'expired';
      this.expired.push(t.id);
      this.emit('ticket_expired', [{ ticket_id: t.id, cve_id: t.cve_id }]);
    }
    return due.length;
  }
  // The expired order a view would see if expiry ran now (unpoked tickets appended by deadline).
  viewExpired(now) {
    const extra = this.open
      .map((id) => this.tickets[id])
      .filter((t) => now >= t.deadline_ms)
      .sort((a, b) => a.deadline_ms - b.deadline_ms || a.id - b.id)
      .map((t) => t.id);
    return extra.length ? this.expired.concat(extra) : this.expired;
  }
  settleOne(a, d, id) {
    const t = this.tickets[id];
    d.cursor += 1;
    if (this.statements.has(`${a}|${id}`)) return 0n;
    const burn = (d.committed * BigInt(t.burn_bps)) / 10000n;
    d.committed -= burn;
    this.committedTotal -= burn;
    this.totalSupply -= burn;
    this.burnedTotal += burn;
    d.missed += 1;
    d.streak = 0;
    d.burned += burn;
    t.missed += 1;
    t.burned += burn;
    this.missesTotal += 1;
    this.applyMonth(d, monthOf(t.deadline_ms), 'missed', burn);
    this.emit('missed', [{ account_id: a, ticket_id: id, cve_id: t.cve_id, burned: burn.toString() }]);
    if (burn > 0n) this.emit('ft_burn', [{ owner_id: a, amount: burn.toString(), memo: `missed ${t.cve_id}` }]);
    return burn;
  }
  // Only on-call desks settle; anything else is a no-op that reports nothing to do.
  settleAccount(a, limit) {
    const d = this.desk(a);
    if (!d || a === this.contractId || !d.on_call) return { settled: 0, remaining: 0, burned: 0n };
    let settled = 0;
    let burned = 0n;
    while (d.cursor < this.expired.length && settled < limit) {
      burned += this.settleOne(a, d, this.expired[d.cursor]);
      settled += 1;
    }
    return { settled, remaining: this.expired.length - d.cursor, burned };
  }
  // settle_or_panic. The contract reverts a settle that ends in a panic, so the mock refuses before
  // touching anything when one call cannot finish.
  settleOrPanic(a) {
    const d = this.desk(a);
    if (d?.on_call && this.expired.length - d.cursor > SETTLE_LIMIT) panic('account behind: call settle first');
    this.settleAccount(a, SETTLE_LIMIT);
  }
  pendingFor(a, now) {
    const d = this.desk(a);
    const none = { effective: d ? d.committed : 0n, pending: 0n, unsettled: 0, misses: 0, monthMisses: 0, monthBurn: 0n };
    if (!d || a === this.contractId || !d.on_call) return none;
    const exp = this.viewExpired(now);
    const month = monthOf(now);
    let eff = d.committed;
    let misses = 0;
    let monthMisses = 0;
    let monthBurn = 0n;
    for (let i = d.cursor; i < exp.length; i++) {
      const t = this.tickets[exp[i]];
      if (this.statements.has(`${a}|${t.id}`)) continue;
      const burn = (eff * BigInt(t.burn_bps)) / 10000n;
      eff -= burn;
      misses += 1;
      if (monthOf(t.deadline_ms) === month) {
        monthMisses += 1;
        monthBurn += burn;
      }
    }
    return { effective: eff, pending: d.committed - eff, unsettled: exp.length - d.cursor, misses, monthMisses, monthBurn };
  }

  // ----- change methods (now passed explicitly) -----
  storage_deposit(caller, now, { account_id } = {}) {
    this.runExpiry(now);
    const a = account_id || caller;
    if (!this.desks.has(a)) {
      this.desks.set(a, newDesk(now));
      if (!this.balances.has(a)) this.balances.set(a, 0n);
    }
    return { total: '1250000000000000000000', available: '0' };
  }
  claim_starter(caller, now) {
    this.runExpiry(now);
    const d = this.mustDesk(caller);
    if (d.claimed_starter) panic('starter already claimed');
    const bag = BigInt(this.config.starter_bag);
    const pool = this.bal(this.contractId);
    if (pool < bag || pool === 0n) panic('desk pool is empty');
    this.balances.set(this.contractId, pool - bag);
    this.balances.set(caller, this.bal(caller) + bag);
    d.claimed_starter = true;
    this.emit('ft_transfer', [{ old_owner_id: this.contractId, new_owner_id: caller, amount: bag.toString(), memo: 'starter bag' }]);
    return bag.toString();
  }
  go_on_call(caller, now, { amount }) {
    this.runExpiry(now);
    const d = this.mustDesk(caller);
    let amt;
    try {
      amt = BigInt(amount);
    } catch {
      amt = 0n;
    }
    if (amt <= 0n) panic('amount must be positive');
    if (!d.on_call && amt < BigInt(this.config.min_commit)) panic('commit at least the minimum to go on call');
    // The free balance check cannot change during the settle below, so it runs first and nothing
    // has to be undone when it fails.
    if (this.bal(caller) < amt) panic('not enough free balance');
    if (d.on_call) this.settleOrPanic(caller);
    else {
      d.on_call = true;
      d.cursor = this.expired.length;
      d.on_call_since_ms = now;
      if (!d.first_on_call_ms) {
        d.first_on_call_ms = now;
        this.roster.push(caller);
      }
    }
    this.balances.set(caller, this.bal(caller) - amt);
    d.committed += amt;
    this.committedTotal += amt;
    this.emit('on_call', [{ account_id: caller, amount: amt.toString(), committed: d.committed.toString() }]);
    return this.get_desk(now, { account_id: caller });
  }
  clock_out(caller, now) {
    this.runExpiry(now);
    const d = this.desk(caller);
    if (!d || !d.on_call) panic('not on call');
    // Contract order: settle_or_panic, the shift, then the open tickets. Settling first would be
    // reverted by a later panic, so the two refusals are checked before the settle mutates anything.
    if (this.expired.length - d.cursor > SETTLE_LIMIT) panic('account behind: call settle first');
    if (now < d.on_call_since_ms + Number(this.config.min_shift_ms)) panic('your shift is not over');
    for (const id of this.open) {
      if (now < this.tickets[id].deadline_ms && !this.statements.has(`${caller}|${id}`)) panic('answer every open ticket before you clock out');
    }
    this.settleAccount(caller, SETTLE_LIMIT);
    const returned = d.committed;
    this.balances.set(caller, this.bal(caller) + returned);
    this.committedTotal -= returned;
    d.committed = 0n;
    d.on_call = false;
    this.emit('clocked_out', [{ account_id: caller, returned: returned.toString() }]);
    return this.get_desk(now, { account_id: caller });
  }
  report_ticket(caller, now, { report }) {
    if (!this.config.reporters.includes(caller)) panic('not a reporter');
    if (!CVE_RE.test(report.cve_id) || report.cve_id.length > 24) panic('bad cve id');
    if (utf8len(report.vendor) > 80 || utf8len(report.product) > 80) panic('field too long');
    if (report.date_added.length !== 10 || report.due_date.length !== 10) panic('field too long');
    this.runExpiry(now);
    if (this.byCve.has(report.cve_id)) panic('ticket exists');
    if (Number(report.deadline_ms) < now + Number(this.config.min_window_ms)) panic('window too short');
    if (Number(report.deadline_ms) > now + MAX_WINDOW_MS) panic('window too long');
    const h = JSON.stringify(report);
    const set = this.pending.get(h) || new Set();
    if (set.has(caller)) panic('already confirmed');
    set.add(caller);
    this.pending.set(h, set);
    if (set.size < this.config.quorum) return { activated: false, ticket_id: null, confirmations: set.size };
    if (this.open.length >= this.config.max_open) panic('too many open tickets');
    const day = Math.floor(now / DAY);
    if (day !== this.dayIndex) {
      this.dayIndex = day;
      this.openedToday = 0;
    }
    if (this.openedToday >= this.config.max_open) panic('too many tickets today');
    this.openedToday += 1;
    const id = this.tickets.length;
    const t = {
      id,
      cve_id: report.cve_id,
      vendor: report.vendor,
      product: report.product,
      date_added: report.date_added,
      due_date: report.due_date,
      ransomware: Boolean(report.ransomware),
      opened_at_ms: now,
      deadline_ms: Number(report.deadline_ms),
      burn_bps: report.ransomware ? this.config.ransom_miss_bps : this.config.miss_bps,
      state: 'open',
      closes: 0,
      not_affected: 0,
      fixed: 0,
      mitigated: 0,
      missed: 0,
      burned: 0n,
    };
    this.tickets.push(t);
    this.byCve.set(t.cve_id, id);
    this.open.push(id);
    this.pending.delete(h);
    this.emit('ticket_opened', [{ ticket_id: id, cve_id: t.cve_id, deadline_ms: String(t.deadline_ms), burn_bps: t.burn_bps }]);
    return { activated: true, ticket_id: id, confirmations: set.size };
  }
  close_ticket(caller, now, { ticket_id, status }) {
    this.runExpiry(now);
    const d = this.mustDesk(caller);
    if (!d.on_call) panic('go on call first: go_on_call');
    // A miss that is already due resets the streak before this answer counts; a desk too far behind to
    // settle inside the call is refused (contract rule: settle_or_panic).
    this.settleOrPanic(caller);
    const t = this.tickets[ticket_id];
    if (!t) panic('no such ticket');
    if (t.state === 'expired' || now >= t.deadline_ms) panic('deadline passed');
    if (!STATUSES.includes(status)) panic('bad status');
    const k = `${caller}|${ticket_id}`;
    const prev = this.statements.get(k);
    if (prev) {
      t[prev.status] -= 1;
      t[status] += 1;
    } else {
      t.closes += 1;
      t[status] += 1;
      d.on_time += 1;
      d.streak += 1;
      d.best_streak = Math.max(d.best_streak, d.streak);
      this.applyMonth(d, monthOf(now), 'on_time');
      this.statementsTotal += 1;
    }
    const st = { status, at_ms: now };
    this.statements.set(k, st);
    this.emit('statement', [{ account_id: caller, ticket_id, cve_id: t.cve_id, status, at_ms: String(now) }]);
    return { status, at_ms: String(now) };
  }
  settle(caller, now, { account_id, limit }) {
    this.runExpiry(now);
    const lim = Math.min(Math.max(Number(limit ?? 50), 0), 200);
    const r = this.settleAccount(account_id, lim);
    return { settled: r.settled, remaining: r.remaining, burned: r.burned.toString() };
  }
  poke(caller, now) {
    return this.runExpiry(now);
  }
  // Transfers move the free balance only and settle nobody.
  ft_transfer(caller, now, { receiver_id, amount }) {
    this.runExpiry(now);
    const d = this.mustDesk(caller);
    if (!this.desk(receiver_id) && receiver_id !== this.contractId) panic(`The account ${receiver_id} is not registered`);
    if (receiver_id === caller) panic('The sender and receiver should be different');
    const amt = BigInt(amount);
    if (amt <= 0n) panic('The amount should be a positive number');
    const free = this.bal(caller);
    if (amt > free) {
      if (amt > free + d.committed) panic("The account doesn't have enough balance");
      panic('not enough free balance: committed tokens cannot move');
    }
    this.balances.set(caller, free - amt);
    this.balances.set(receiver_id, this.bal(receiver_id) + amt);
    this.emit('ft_transfer', [{ old_owner_id: caller, new_owner_id: receiver_id, amount: amt.toString() }]);
    return null;
  }

  // ----- views -----
  ticketView(t, now) {
    return {
      id: t.id,
      cve_id: t.cve_id,
      vendor: t.vendor,
      product: t.product,
      date_added: t.date_added,
      due_date: t.due_date,
      ransomware: t.ransomware,
      opened_at_ms: String(t.opened_at_ms),
      deadline_ms: String(t.deadline_ms),
      burn_bps: t.burn_bps,
      state: t.state === 'expired' || now >= t.deadline_ms ? 'expired' : 'open',
      closes: t.closes,
      not_affected: t.not_affected,
      fixed: t.fixed,
      mitigated: t.mitigated,
      missed: t.missed,
      burned: t.burned.toString(),
    };
  }
  get_stats(now) {
    const exp = this.viewExpired(now);
    let onCall = 0;
    for (const d of this.desks.values()) if (d.on_call) onCall += 1;
    return {
      total_supply: this.totalSupply.toString(),
      initial_supply: String(this.config.initial_supply),
      burned_total: this.burnedTotal.toString(),
      desk_pool: this.bal(this.contractId).toString(),
      tickets_opened: this.tickets.length,
      tickets_open: this.tickets.length - exp.length,
      tickets_expired: exp.length,
      statements_total: this.statementsTotal,
      accounts: this.desks.size,
      on_call: onCall,
      committed_total: this.committedTotal.toString(),
      roster: this.roster.length,
      misses_total: this.missesTotal,
      now_ms: String(now),
    };
  }
  get_config() {
    return { ...this.config };
  }
  get_desk(now, { account_id }) {
    const month = monthOf(now);
    const blank = {
      registered: false, balance: '0', on_call: false, committed: '0', stored_committed: '0', pending_burn: '0', unsettled: 0,
      on_time: 0, missed: 0, streak: 0, best_streak: 0, burned: '0', month, month_on_time: 0, month_missed: 0, month_burned: '0',
      claimed_starter: false, registered_at_ms: '0', first_on_call_ms: '0', on_call_since_ms: '0', shift_ends_ms: '0',
    };
    if (account_id === this.contractId) return { ...blank, registered: true, balance: this.bal(account_id).toString() };
    const d = this.desk(account_id);
    if (!d) return blank;
    const p = this.pendingFor(account_id, now);
    const same = d.month === month;
    return {
      registered: true,
      balance: this.bal(account_id).toString(),
      on_call: d.on_call,
      committed: p.effective.toString(),
      stored_committed: d.committed.toString(),
      pending_burn: p.pending.toString(),
      unsettled: p.unsettled,
      on_time: d.on_time,
      missed: d.missed + p.misses,
      streak: p.misses ? 0 : d.streak,
      best_streak: d.best_streak,
      burned: (d.burned + p.pending).toString(),
      month,
      month_on_time: same ? d.month_on_time : 0,
      month_missed: (same ? d.month_missed : 0) + p.monthMisses,
      month_burned: ((same ? d.month_burned : 0n) + p.monthBurn).toString(),
      claimed_starter: d.claimed_starter,
      registered_at_ms: String(d.registered_at_ms),
      first_on_call_ms: String(d.first_on_call_ms),
      on_call_since_ms: String(d.on_call_since_ms),
      shift_ends_ms: d.on_call ? String(d.on_call_since_ms + Number(this.config.min_shift_ms)) : '0',
    };
  }
  get_roster(now, { from_index, limit }) {
    const lim = Math.min(Math.max(Number(limit) || 0, 0), ROSTER_MAX);
    const from = Math.max(Number(from_index) || 0, 0);
    return this.roster.slice(from, from + lim).map((a) => ({ account_id: a, desk: this.get_desk(now, { account_id: a }) }));
  }

  // ----- persistence -----
  toJSON() {
    return {
      contractId: this.contractId,
      config: this.config,
      balances: [...this.balances].map(([k, v]) => [k, v.toString()]),
      desks: [...this.desks].map(([k, d]) => [k, { ...d, burned: d.burned.toString(), committed: d.committed.toString(), month_burned: d.month_burned.toString() }]),
      tickets: this.tickets.map((t) => ({ ...t, burned: t.burned.toString() })),
      open: this.open,
      expired: this.expired,
      statements: [...this.statements],
      totalSupply: this.totalSupply.toString(),
      burnedTotal: this.burnedTotal.toString(),
      statementsTotal: this.statementsTotal,
      roster: this.roster,
      committedTotal: this.committedTotal.toString(),
      missesTotal: this.missesTotal,
    };
  }
  static fromJSON(j) {
    const l = new Ledger(j.contractId, j.config);
    l.balances = new Map(j.balances.map(([k, v]) => [k, BigInt(v)]));
    l.desks = new Map(
      j.desks.map(([k, d]) => [k, { ...d, burned: BigInt(d.burned), committed: BigInt(d.committed), month_burned: BigInt(d.month_burned) }]),
    );
    l.tickets = j.tickets.map((t) => ({ ...t, burned: BigInt(t.burned) }));
    l.byCve = new Map(l.tickets.map((t) => [t.cve_id, t.id]));
    l.open = j.open;
    l.expired = j.expired;
    l.statements = new Map(j.statements);
    l.totalSupply = BigInt(j.totalSupply);
    l.burnedTotal = BigInt(j.burnedTotal);
    l.statementsTotal = j.statementsTotal;
    l.roster = j.roster;
    l.committedTotal = BigInt(j.committedTotal);
    l.missesTotal = j.missesTotal;
    return l;
  }
}

function toReport(e, deadlineMs) {
  return {
    cve_id: e.cveID,
    vendor: e.vendorProject.slice(0, 80),
    product: e.product.slice(0, 80),
    date_added: e.dateAdded,
    due_date: e.dueDate,
    ransomware: e.knownRansomwareCampaignUse === 'Known',
    deadline_ms: String(deadlineMs),
  };
}

// The seeded desks. Each has a fixed habit so the page tells the same story every time:
// `answers(i, tag)` decides per ticket (tags: old, clean, missed, open), `join` is when it takes the
// pager, `leave` when it clocks out (after answering whatever is open, like the contract demands).
const SEED_DESKS = [
  { id: 'oncall-bot.testnet', commit: 6000, join: 'start', answers: () => true },
  { id: 'soc-night-shift.testnet', commit: 5000, join: 'start', answers: (i) => i !== 2 },
  { id: 'patchmonday.testnet', commit: 3000, join: 'beforeClean', answers: () => true, maxOpen: 1 },
  {
    id: 'ciso-who-cares.testnet',
    commit: 4000,
    join: 'start',
    answers: (i, tag) => (tag === 'clean' ? true : tag === 'missed' || tag === 'open' ? false : i % 3 !== 0),
  },
  {
    id: 'legacy-server.testnet',
    commit: 8000,
    join: 'start',
    answers: (i, tag) => (tag === 'clean' ? true : tag === 'old' ? i % 4 === 0 : false),
  },
  { id: 'ghost-holder.testnet', commit: 2000, join: 'afterClean', answers: () => false },
  { id: 'vacation-mode.testnet', commit: 1500, join: 'second', leave: true, answers: () => true },
  { id: 'helpdesk-hal.testnet', commit: 1000, join: 'afterMissed', answers: (i, tag) => tag === 'open', maxOpen: 2 },
];
// Registered holders that never take the pager: they count as desks but are not on the roster.
const PLAIN_HOLDERS = ['hodl-hank.testnet', 'weekend-admin.testnet'];

// Replay a schedule of real tickets and the seeded desks, through the ledger's own methods, so every
// burn, streak and monthly counter on screen came from the rules above.
function seed(ledger, schedule, now, rnd, { pre, withRoster }) {
  const reporters = ledger.config.reporters;
  const firstOpen = Math.min(...schedule.map((s) => s.openAt));
  const regAt = firstOpen - 2 * pre;
  for (const a of [...SEED_DESKS.map((d) => d.id), ...PLAIN_HOLDERS]) {
    ledger.storage_deposit(a, regAt);
    ledger.claim_starter(a, regAt);
  }
  const events = [];
  schedule.forEach((s) => {
    events.push({ at: s.openAt, order: 0, run: () => {
      ledger.report_ticket(reporters[0], s.openAt, { report: s.report });
      ledger.report_ticket(reporters[1], s.openAt, { report: s.report });
    } });
  });
  if (withRoster) {
    const tagIndex = (tag) => schedule.findIndex((s) => s.tag === tag);
    const deadline = (i) => Number(schedule[i].report.deadline_ms);
    const minShift = Number(ledger.config.min_shift_ms);
    for (const desk of SEED_DESKS) {
      const joinAt = {
        start: firstOpen - pre,
        second: schedule[1].openAt - pre,
        beforeClean: schedule[Math.max(0, tagIndex('clean') - 3)].openAt - pre,
        afterClean: deadline(tagIndex('clean')) + pre,
        afterMissed: deadline(tagIndex('missed')) + pre,
      }[desk.join];
      const leaveAt = desk.leave ? joinAt + minShift + pre : Infinity;
      if (joinAt >= now) continue;
      events.push({ at: joinAt, order: 1, run: () => ledger.go_on_call(desk.id, joinAt, { amount: (BigInt(desk.commit) * TOKEN).toString() }) });
      let openAnswered = 0;
      schedule.forEach((s, i) => {
        const dl = Number(s.report.deadline_ms);
        const lo = Math.max(s.openAt, joinAt);
        const hi = Math.min(dl, now, leaveAt);
        const r = rnd();
        if (hi <= lo || dl <= joinAt) return;
        // A desk that clocks out answers everything open before it leaves, or the contract refuses.
        const must = desk.leave && dl > leaveAt;
        if (!must && !desk.answers(i, s.tag)) return;
        if (s.tag === 'open' && desk.maxOpen != null && openAnswered++ >= desk.maxOpen) return;
        const at = Math.floor(lo + (hi - lo) * (0.05 + r * 0.85));
        const status = STATUSES[Math.floor(rnd() * 3)];
        events.push({ at, order: 2, run: () => ledger.close_ticket(desk.id, at, { ticket_id: ledger.byCve.get(s.report.cve_id), status }) });
      });
      if (leaveAt < now) events.push({ at: leaveAt, order: 3, run: () => ledger.clock_out(desk.id, leaveAt) });
    }
  }
  events.sort((a, b) => a.at - b.at || a.order - b.order);
  for (const e of events) e.run();
  // The janitor (npm run janitor) has settled everyone up to now.
  ledger.runExpiry(now);
  for (const a of ledger.roster) ledger.settle(a, now, { account_id: a, limit: 200 });
}

function configFor(deskKey) {
  return {
    reporters: ['rep1.kevin-it.testnet', 'rep2.kevin-it.testnet', 'rep3.kevin-it.testnet'],
    quorum: 2,
    miss_bps: 100,
    ransom_miss_bps: 500,
    min_window_ms: String(deskKey === 'drill' ? MINUTE : HOUR),
    max_open: 128,
    starter_bag: (10_000n * TOKEN).toString(),
    initial_supply: (1_000_000_000n * TOKEN).toString(),
    min_commit: (1_000n * TOKEN).toString(),
    min_shift_ms: String(deskKey === 'drill' ? 30 * MINUTE : 7 * DAY),
  };
}

// Live desk: real recent KEV entries on deadlines set around now, so the queue always has a ticket
// due within a day, a ransomware-flagged one, one opened in the last 48 hours, an expired ticket the
// on-call desks missed a few hours ago and one everyone answered the day before.
function liveSchedule(now) {
  const pool = recent.slice().sort((a, b) => a.dateAdded.localeCompare(b.dateAdded) || a.cveID.localeCompare(b.cveID));
  const ransomEntry = pool.find((e) => e.knownRansomwareCampaignUse === 'Known');
  const rest = pool.filter((e) => e !== ransomEntry);
  const take = () => rest.pop();
  const plan = [
    { tag: 'open', deadline: now + 12 * DAY, openAt: now - 2 * DAY },
    { tag: 'open', deadline: now + 6 * DAY, openAt: now - 3 * DAY },
    { tag: 'open', deadline: now + 70 * HOUR, openAt: now - 20 * HOUR },
    { tag: 'open', deadline: now + 54 * HOUR, openAt: now - 30 * HOUR, ransom: true },
    { tag: 'open', deadline: now + 18 * HOUR, openAt: now - 54 * HOUR },
    { tag: 'missed', deadline: now - 3 * HOUR, openAt: now - 75 * HOUR },
    { tag: 'clean', deadline: now - 30 * HOUR, openAt: now - 96 * HOUR },
  ];
  const OLD = 22;
  for (let k = 0; k < OLD; k++) {
    const deadline = now - 40 * HOUR - k * 48 * HOUR;
    plan.push({ tag: 'old', deadline, openAt: deadline - 72 * HOUR });
  }
  return plan
    .map((p) => {
      const e = p.ransom && ransomEntry ? ransomEntry : take();
      return e ? { tag: p.tag, report: toReport(e, p.deadline), openAt: p.openAt } : null;
    })
    .filter(Boolean)
    .sort((a, b) => Number(a.report.deadline_ms) - Number(b.report.deadline_ms));
}

async function drillSchedule(now) {
  const all = (await import('virtual:kev-all')).default;
  const entries = DRILL_CVES.map((id) => all.find((v) => v.cveID === id)).filter(Boolean);
  // Four already expired a few minutes ago, six due over the next half hour.
  const offsets = [-14, -9, -5, -2, 3, 6, 10, 15, 22, 30];
  const tags = ['old', 'clean', 'old', 'missed', 'open', 'open', 'open', 'open', 'open', 'open'];
  return entries.map((e, i) => {
    const deadline = now + offsets[i] * MINUTE;
    return { tag: tags[i], report: toReport(e, deadline), openAt: deadline - 25 * MINUTE - i * MINUTE };
  });
}

async function buildLedger(deskKey, contractId, now, withRoster) {
  const drill = deskKey === 'drill';
  const ledger = new Ledger(contractId, configFor(deskKey));
  const schedule = drill ? await drillSchedule(now) : liveSchedule(now);
  seed(ledger, schedule, now, mulberry32(drill ? 7 : 11), { pre: drill ? MINUTE : HOUR, withRoster });
  return ledger;
}

export async function createMockChain({ contractId, deskKey }) {
  const params = new URLSearchParams(location.search);
  const fail = new Set((params.get('fail') || '').split(',').filter(Boolean));
  const withRoster = params.get('roster') !== '0';
  const storeKey = `kevin.mock.v3.${deskKey}${withRoster ? '' : '.empty'}`;
  let offset = 0;
  let ledger;
  try {
    const saved = JSON.parse(sessionStorage.getItem(storeKey) || 'null');
    if (saved) {
      ledger = Ledger.fromJSON(saved.ledger);
      offset = saved.offset || 0;
    }
  } catch {
    ledger = null;
  }
  if (!ledger) ledger = await buildLedger(deskKey, contractId, Date.now(), withRoster);
  const now = () => Date.now() + offset;
  // The simulated on-call bot answers every open ticket it has not answered, like npm run oncall.
  const BOT = 'oncall-bot.testnet';
  const botRound = () => {
    const t = now();
    if (!ledger.desk(BOT)?.on_call) return;
    for (const id of ledger.open) {
      const tk = ledger.tickets[id];
      if (t < tk.deadline_ms && !ledger.statements.has(`${BOT}|${id}`)) ledger.close_ticket(BOT, t, { ticket_id: id, status: 'not_affected' });
    }
  };
  // The simulated janitor settles the seeded desks after the clock moves. The guest's own desk is
  // left alone so its pending burn shows until it settles (or answers, tops up or clocks out).
  const janitor = () => {
    const t = now();
    const g = loadGuest(NETWORK);
    ledger.runExpiry(t);
    for (const a of ledger.roster) if (a !== g?.accountId) ledger.settle(a, t, { account_id: a, limit: 200 });
  };
  botRound();
  const persist = () => {
    try {
      sessionStorage.setItem(storeKey, JSON.stringify({ ledger: ledger.toJSON(), offset }));
    } catch {
      /* storage full or disabled: the mock keeps working in memory */
    }
  };
  persist();
  let faucetFailures = fail.has('faucet') ? 1 : 0;

  const outage = (what) => new Error(`Failed to fetch: mock RPC outage (?fail=${what})`);
  const view = async (fn) => {
    await sleep(60 + Math.random() * 90);
    if (fail.has('rpc')) throw outage('rpc');
    return fn(now());
  };
  const call = async (fn, ms = 450) => {
    await sleep(ms + Math.random() * 300);
    const g = loadGuest(NETWORK);
    if (!g?.created) throw Object.assign(new Error('Open a guest desk first.'), { code: 'no_desk' });
    const value = fn(g.accountId, now());
    persist();
    // No real transaction exists on the demo chain, so there is no hash to link.
    return { value, txHash: null, demo: true };
  };
  const statementOf = (accountId, id) => {
    const s = ledger.statements.get(`${accountId}|${id}`);
    return s ? { status: s.status, at_ms: String(s.at_ms) } : null;
  };

  const chain = {
    mock: true,
    deskKey,
    contractId,
    network: NETWORK,
    now,
    getStats: () => view((t) => ledger.get_stats(t)),
    getConfig: () => view(() => ledger.get_config()),
    getOpenTickets: () =>
      view((t) =>
        ledger.open
          .map((id) => ledger.tickets[id])
          .sort((a, b) => a.deadline_ms - b.deadline_ms)
          .map((x) => ledger.ticketView(x, t)),
      ),
    getAllTickets: () => view((t) => ledger.tickets.map((x) => ledger.ticketView(x, t))),
    getTickets: (fromIndex, limit) => view((t) => ledger.tickets.slice(fromIndex, fromIndex + Math.min(limit, 100)).map((x) => ledger.ticketView(x, t))),
    getDesk: (accountId) => view((t) => ledger.get_desk(t, { account_id: accountId })),
    getRoster: (fromIndex, limit) =>
      view((t) => {
        if (fail.has('roster')) throw outage('roster');
        return ledger.get_roster(t, { from_index: fromIndex, limit });
      }),
    getStatement: (accountId, id) => view(() => statementOf(accountId, id)),
    getStatements: (accountId, ids) => view(() => ids.map((id) => statementOf(accountId, id))),
    storageBounds: () => view(() => ({ min: '1250000000000000000000', max: '1250000000000000000000' })),
    ftBalanceOf: (accountId) =>
      view((t) => (ledger.bal(accountId) + (accountId === contractId ? 0n : ledger.pendingFor(accountId, t).effective)).toString()),

    guest: () => loadGuest(NETWORK),
    forgetGuest: () => clearGuest(NETWORK),
    async createGuest(onStep = () => {}) {
      let g = loadGuest(NETWORK);
      if (!g || g.created) {
        const kp = KeyPair.fromRandom('ed25519');
        g = { accountId: randomGuestId('.testnet'), secretKey: kp.toString(), publicKey: kp.getPublicKey().toString(), created: false };
        saveGuest(NETWORK, g);
      }
      onStep('faucet');
      await sleep(900);
      if (faucetFailures > 0) {
        faucetFailures -= 1;
        throw Object.assign(new Error('The testnet faucet is rate limiting this network address. It allows about 10 new accounts per address every 10 hours.'), { code: 'rate_limit' });
      }
      onStep('confirm');
      await sleep(600);
      g = { ...g, created: true, createdAt: Date.now() };
      saveGuest(NETWORK, g);
      return g;
    },
    async register(onStep = () => {}) {
      onStep('bounds');
      await sleep(250);
      onStep('register');
      return call((a, t) => {
        ledger.storage_deposit(a, t, { account_id: a, registration_only: true });
        ledger.claim_starter(a, t);
        return null;
      }, 800);
    },
    goOnCall: (amount) => call((a, t) => ledger.go_on_call(a, t, { amount: amount.toString() })),
    clockOut: () => call((a, t) => ledger.clock_out(a, t), 600),
    closeTicket: (ticketId, status) => call((a, t) => ledger.close_ticket(a, t, { ticket_id: ticketId, status })),
    settle: (accountId) => call((a, t) => ledger.settle(a, t, { account_id: accountId, limit: 50 }), 600),
    poke: () => call((a, t) => ledger.poke(a, t)),
    transfer: (receiverId, amount) => call((a, t) => ledger.ft_transfer(a, t, { receiver_id: receiverId, amount: amount.toString() })),
    async addOncallKey() {
      const r = await call((a) => {
        const kp = KeyPair.fromRandom('ed25519');
        return { accountId: a, contractId, publicKey: kp.getPublicKey().toString(), secretKey: kp.toString() };
      }, 700);
      return { ...r.value, txHash: null, demo: true };
    },
    // The two always-on demo desks the strip above the queue reads (simulated desks here).
    demoAccounts: [
      { id: 'oncall-bot.testnet', label: 'On-call bot', note: 'answers every ticket' },
      { id: 'ghost-holder.testnet', label: 'Never answers', note: 'on call, silent on every ticket' },
    ],

    // Mock-only clock controls, used by the mock toolbar and the proof driver.
    advance(ms) {
      botRound();
      offset += ms;
      janitor();
      persist();
    },
    nextDeadline() {
      const t = now();
      const next = ledger.open.map((id) => ledger.tickets[id].deadline_ms).filter((d) => d > t).sort((a, b) => a - b)[0];
      return next ?? null;
    },
    skipToNextDeadline() {
      const next = chain.nextDeadline();
      if (next) chain.advance(next - now() + 1000);
      return next;
    },
    // When the guest's current shift ends, or null when it is not on call.
    shiftEnd() {
      const g = loadGuest(NETWORK);
      const d = g?.created && ledger.desk(g.accountId);
      return d?.on_call ? d.on_call_since_ms + Number(ledger.config.min_shift_ms) : null;
    },
    skipToShiftEnd() {
      const end = chain.shiftEnd();
      if (end && end > now()) chain.advance(end - now() + 1000);
      return end;
    },
    reset() {
      sessionStorage.removeItem(storeKey);
    },
    events: () => ledger.events.slice(),
  };
  window.__kevinMock = chain;
  return chain;
}
