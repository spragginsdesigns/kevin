// Pure BigInt reference model of the KEVIN settlement rule (v2, the On-Call Program). The simulation runs on it
// and `npm run claims` compares it with a recorded testnet round, so it follows the contract's order of
// operations rather than whatever is shortest: expiry first in every change method, burns applied one expired
// ticket at a time in expiry order, floor division at every step. Panics are thrown as Error with the
// contract's exact panic text, and a method that panics changes nothing (the contract reverts).
// Quorum is not modeled: open() is the moment a report reaches quorum and the ticket activates.
//
// v2: holding KEVIN asks nothing. Each account has a free balance, which never burns and moves freely, and a
// committed amount, which exists only while the desk is on call (goOnCall). Only an on-call desk can answer,
// only an on-call desk is liable, and a miss burns floor(committed * burn_bps / 10000) of the committed amount.

export const BPS_DENOMINATOR = 10_000n;
export const STATUSES = Object.freeze(['not_affected', 'fixed', 'mitigated']);
export const SETTLE_DEFAULT_LIMIT = 50;
export const SETTLE_MAX_LIMIT = 200;
// close_ticket settles the caller this far first; go_on_call (top-up) and clock_out settle this far and then
// refuse with "account behind" if anything is still unsettled.
export const TRANSFER_SETTLE_LIMIT = 50;
// get_roster returns at most this many entries per call.
export const ROSTER_MAX_LIMIT = 50;
// A report cannot set a deadline further out than this. CISA's longest real window in the catalog is 184 days.
export const MAX_WINDOW_MS = 200n * 86_400_000n;
const DAY_MS = 86_400_000n;

const CVE_RE = /^CVE-\d{4}-\d+$/;
const utf8Length = (s) => new TextEncoder().encode(s).length;

/** One missed ticket: burn = floor(amount * bps / 10000). Returns { burned, balance } (the amount after the burn). */
export function applyMiss(balance, bps) {
  const b = BigInt(balance);
  const burned = (b * BigInt(bps)) / BPS_DENOMINATOR;
  return { burned, balance: b - burned };
}

/**
 * The UTC month of a millisecond timestamp as YYYYMM (e.g. 202611), with integer civil-from-days arithmetic
 * (Howard Hinnant's algorithm), the same computation the contract does on the block timestamp.
 */
export function monthOf(ms) {
  const days = BigInt(ms) / DAY_MS;
  const z = days + 719_468n;
  const era = (z >= 0n ? z : z - 146_096n) / 146_097n;
  const doe = z - era * 146_097n;
  const yoe = (doe - doe / 1_460n + doe / 36_524n - doe / 146_096n) / 365n;
  const doy = doe - (365n * yoe + yoe / 4n - yoe / 100n);
  const mp = (5n * doy + 2n) / 153n;
  const m = mp < 10n ? mp + 3n : mp - 9n;
  const y = yoe + era * 400n + (m <= 2n ? 1n : 0n);
  return Number(y * 100n + m);
}

function panic(message) {
  throw new Error(message);
}

export class Ledger {
  constructor({
    poolId = 'pool',
    missBps = 100,
    ransomMissBps = 500,
    minWindowMs = 0,
    maxOpen = Infinity,
    starterBag = 0n,
    initialSupply = 0n,
    minCommit = 1n,
    minShiftMs = 0n,
  } = {}) {
    if (BigInt(minCommit) < 1n) panic('min_commit must be at least 1');
    this.poolId = poolId;
    this.missBps = missBps;
    this.ransomMissBps = ransomMissBps;
    this.minWindowMs = minWindowMs;
    this.maxOpen = maxOpen;
    this.starterBag = BigInt(starterBag);
    this.initialSupply = BigInt(initialSupply);
    this.minCommit = BigInt(minCommit);
    this.minShiftMs = BigInt(minShiftMs); // a desk cannot clock out until this long after it went on call
    this.totalSupply = this.initialSupply;
    this.burnedTotal = 0n;
    this.tickets = []; // index is the ticket id
    this.byCve = new Map();
    this.openIds = []; // ids in activation order; expiry takes the due ones in deadline order, then id order
    this.expiredIds = []; // ids in the order they expired; desk cursors index into this
    this.balances = new Map([[poolId, this.initialSupply]]); // FREE balances (and the pool)
    this.desks = new Map();
    this.roster = []; // account ids in the order they first went on call
    this.onCallCount = 0;
    this.committedTotal = 0n; // stored committed, summed over all desks
    this.missesTotal = 0;
    this.statementsTotal = 0;
    // Activations are capped at maxOpen per UTC day, so a corrupt quorum cannot grow storage without bound.
    this.activationDay = -1n;
    this.activatedToday = 0;
  }

  // ---- change methods -------------------------------------------------------------------------

  /** Move every open ticket whose deadline has passed to `expired`. Returns how many moved (the poke() result). */
  expire(nowMs) {
    const now = BigInt(nowMs);
    const still = [];
    const due = [];
    for (const id of this.openIds) {
      (now >= this.tickets[id].deadlineMs ? due : still).push(id);
    }
    // Tickets that expire in the same call go in deadline order, then id order, exactly as the contract
    // appends them. Burns compound with floor division, so the order is part of the rule.
    due.sort((a, b) => {
      const da = this.tickets[a].deadlineMs;
      const db = this.tickets[b].deadlineMs;
      return da < db ? -1 : da > db ? 1 : a - b;
    });
    for (const id of due) {
      this.tickets[id].state = 'expired';
      this.expiredIds.push(id);
    }
    this.openIds = still;
    return due.length;
  }

  poke(nowMs) {
    return this.expire(nowMs);
  }

  /** storage_deposit for a new account. A new desk is not on call and has nothing committed. */
  register(accountId, nowMs) {
    this.expire(nowMs);
    if (this.desks.has(accountId)) return false;
    this.desks.set(accountId, {
      onCall: false,
      committed: 0n, // stored committed
      cursor: this.expiredIds.length, // reset by goOnCall; only read while on call
      statements: new Map(),
      onTime: 0,
      missed: 0,
      streak: 0,
      bestStreak: 0,
      burned: 0n,
      month: 0,
      monthOnTime: 0,
      monthMissed: 0,
      monthBurned: 0n,
      claimedStarter: false,
      registeredAtMs: BigInt(nowMs),
      firstOnCallMs: 0n,
      onCallSinceMs: 0n, // start of the current (or last) shift; set when going on call, kept on clock out
    });
    if (!this.balances.has(accountId)) this.balances.set(accountId, 0n);
    return true;
  }

  /** A report reached quorum. Returns the new ticket. `report` is the contract's TicketReport JSON. */
  open(report, nowMs) {
    this.expire(nowMs);
    const now = BigInt(nowMs);
    const cve = String(report.cve_id);
    if (!CVE_RE.test(cve) || cve.length > 24) panic('bad cve id');
    if (utf8Length(report.vendor) > 80 || utf8Length(report.product) > 80) panic('field too long');
    if (utf8Length(report.date_added) !== 10 || utf8Length(report.due_date) !== 10) panic('field too long');
    if (this.byCve.has(cve)) panic('ticket exists');
    const deadlineMs = BigInt(report.deadline_ms);
    if (deadlineMs < now + BigInt(this.minWindowMs)) panic('window too short');
    if (deadlineMs > now + MAX_WINDOW_MS) panic('window too long');
    if (this.openIds.length >= this.maxOpen) panic('too many open tickets');
    const day = now / DAY_MS;
    if (day !== this.activationDay) {
      this.activationDay = day;
      this.activatedToday = 0;
    }
    if (this.activatedToday >= this.maxOpen) panic('too many tickets today');
    this.activatedToday += 1;
    const ticket = {
      id: this.tickets.length,
      cveId: cve,
      vendor: report.vendor,
      product: report.product,
      dateAdded: report.date_added,
      dueDate: report.due_date,
      ransomware: Boolean(report.ransomware),
      openedAtMs: now,
      deadlineMs,
      burnBps: report.ransomware ? this.ransomMissBps : this.missBps,
      state: 'open',
      closes: 0,
      counts: { not_affected: 0, fixed: 0, mitigated: 0 },
      missed: 0,
      burned: 0n,
    };
    this.tickets.push(ticket);
    this.byCve.set(cve, ticket.id);
    this.openIds.push(ticket.id);
    return ticket;
  }

  /**
   * go_on_call(amount): move `amount` of the free balance into the committed amount. A desk that was not on call
   * becomes liable for every ticket that expires from now on (including tickets already open) and starts a shift
   * of at least minShiftMs. A top-up settles first, so a miss that is already due burns at the old committed
   * amount, and does not restart the shift. Returns the desk view.
   */
  goOnCall(accountId, amount, nowMs) {
    this.expire(nowMs);
    const desk = this.desks.get(accountId);
    if (!desk) panic('register first: storage_deposit');
    const value = BigInt(amount);
    if (value <= 0n) panic('amount must be positive');
    const joining = !desk.onCall;
    if (joining && value < this.minCommit) panic('commit at least the minimum to go on call');
    if (!joining && this.#unsettledCount(desk) > TRANSFER_SETTLE_LIMIT) panic('account behind: call settle first');
    const free = this.balances.get(accountId) ?? 0n;
    // Settlement only touches the committed amount, so this check gives the same answer before or after it.
    if (free < value) panic('not enough free balance');
    if (joining) {
      desk.onCall = true;
      desk.cursor = this.expiredIds.length;
      desk.onCallSinceMs = BigInt(nowMs);
      this.onCallCount += 1;
      if (desk.firstOnCallMs === 0n) {
        desk.firstOnCallMs = BigInt(nowMs);
        this.roster.push(accountId);
      }
    } else {
      this.#settleSome(accountId, TRANSFER_SETTLE_LIMIT);
    }
    this.balances.set(accountId, free - value);
    desk.committed += value;
    this.committedTotal += value;
    return this.desk(accountId, nowMs);
  }

  /**
   * clock_out(): settle, then return every committed token to the free balance. Refused before the shift is over
   * (on_call_since + min_shift), and while any ticket that is open right now has no statement from this desk, so
   * nobody can leave to dodge a deadline or answer only what is open and skip what follows.
   */
  clockOut(accountId, nowMs) {
    this.expire(nowMs);
    const desk = this.desks.get(accountId);
    if (!desk || !desk.onCall) panic('not on call');
    if (this.#unsettledCount(desk) > TRANSFER_SETTLE_LIMIT) panic('account behind: call settle first');
    const now = BigInt(nowMs);
    if (now < desk.onCallSinceMs + this.minShiftMs) panic('your shift is not over');
    const unanswered = this.openIds.some((id) => now < this.tickets[id].deadlineMs && !desk.statements.has(id));
    if (unanswered) panic('answer every open ticket before you clock out');
    this.#settleSome(accountId, TRANSFER_SETTLE_LIMIT);
    const returned = desk.committed;
    this.balances.set(accountId, (this.balances.get(accountId) ?? 0n) + returned);
    this.committedTotal -= returned;
    desk.committed = 0n;
    desk.onCall = false;
    this.onCallCount -= 1;
    return this.desk(accountId, nowMs);
  }

  /** close_ticket. Only an on-call desk may answer. The first statement counts; a later one replaces it. */
  close(accountId, ticketId, status, nowMs) {
    this.expire(nowMs);
    const desk = this.desks.get(accountId);
    if (!desk) panic('register first: storage_deposit');
    if (!desk.onCall) panic('go on call first: go_on_call');
    // settle_or_panic: an answer never counts toward a streak across a miss that is still unsettled
    if (this.#unsettledCount(desk) > TRANSFER_SETTLE_LIMIT) panic('account behind: call settle first');
    if (!STATUSES.includes(status)) panic(`unknown status ${status}`);
    const t = this.tickets[ticketId];
    if (!t) panic('no such ticket');
    const now = BigInt(nowMs);
    if (t.state === 'expired' || now >= t.deadlineMs) panic('deadline passed');
    // Like the contract: a miss that is already due settles (and resets the streak) before this answer counts.
    this.#settleSome(accountId, TRANSFER_SETTLE_LIMIT);
    const prior = desk.statements.get(ticketId);
    if (prior) {
      t.counts[prior.status] -= 1;
    } else {
      t.closes += 1;
      desk.onTime += 1;
      desk.streak += 1;
      if (desk.streak > desk.bestStreak) desk.bestStreak = desk.streak;
      this.#applyMonth(desk, monthOf(now), { onTime: 1 });
      this.statementsTotal += 1;
    }
    t.counts[status] += 1;
    const statement = { status, atMs: now };
    desk.statements.set(ticketId, statement);
    return statement;
  }

  /** settle(account, limit). Permissionless. A no-op for a desk that is not on call, the pool, or an unknown id. */
  settle(accountId, limit, nowMs) {
    this.expire(nowMs);
    const n = Math.min(limit ?? SETTLE_DEFAULT_LIMIT, SETTLE_MAX_LIMIT);
    return this.#settleSome(accountId, n);
  }

  /** ft_transfer. Moves the free balance only and settles nobody: committed tokens cannot move. */
  transfer(senderId, receiverId, amount, nowMs) {
    this.expire(nowMs);
    const value = BigInt(amount);
    if (senderId === receiverId) panic('Sender and receiver should be different');
    if (value <= 0n) panic('The amount should be a positive number');
    for (const id of [senderId, receiverId]) {
      if (id !== this.poolId && !this.desks.has(id)) panic(`The account ${id} is not registered`);
    }
    const from = this.balances.get(senderId) ?? 0n;
    if (from < value) {
      const committed = this.desks.get(senderId)?.committed ?? 0n;
      panic(value > from + committed ? "The account doesn't have enough balance" : 'not enough free balance: committed tokens cannot move');
    }
    this.balances.set(senderId, from - value);
    this.balances.set(receiverId, (this.balances.get(receiverId) ?? 0n) + value);
  }

  /** claim_starter: credits the free balance. No settle. */
  claimStarter(accountId, nowMs) {
    this.expire(nowMs);
    const desk = this.desks.get(accountId);
    if (!desk) panic('register first: storage_deposit');
    if (desk.claimedStarter) panic('starter already claimed');
    const pool = this.balances.get(this.poolId);
    if (pool < this.starterBag || pool === 0n) panic('desk pool is empty');
    this.balances.set(this.poolId, pool - this.starterBag);
    this.balances.set(accountId, (this.balances.get(accountId) ?? 0n) + this.starterBag);
    desk.claimedStarter = true;
    return this.starterBag;
  }

  // ---- views ----------------------------------------------------------------------------------

  /** Tickets past their deadline in expiry order, including ones nobody has poked yet (views treat them as expired). */
  #virtualExpired(nowMs) {
    const now = BigInt(nowMs);
    const due = this.openIds
      .filter((id) => now >= this.tickets[id].deadlineMs)
      .sort((a, b) => {
        const da = this.tickets[a].deadlineMs;
        const db = this.tickets[b].deadlineMs;
        return da < db ? -1 : da > db ? 1 : a - b;
      });
    return this.expiredIds.concat(due);
  }

  ticketState(ticketId, nowMs) {
    const t = this.tickets[ticketId];
    if (!t) return null;
    return t.state === 'expired' || BigInt(nowMs) >= t.deadlineMs ? 'expired' : 'open';
  }

  statement(accountId, ticketId) {
    return this.desks.get(accountId)?.statements.get(ticketId) ?? null;
  }

  /** Open tickets (by the view rule) sorted by deadline, then id. */
  openTickets(nowMs) {
    const now = BigInt(nowMs);
    return this.openIds
      .map((id) => this.tickets[id])
      .filter((t) => now < t.deadlineMs)
      .sort((a, b) => (a.deadlineMs === b.deadlineMs ? a.id - b.id : a.deadlineMs < b.deadlineMs ? -1 : 1));
  }

  /**
   * What settling this account right now would do to its committed amount, without changing state. A desk that
   * is not on call has nothing pending. `monthMisses` and `monthBurn` count only the pending misses whose ticket
   * deadline falls in the month of `nowMs`.
   */
  pending(accountId, nowMs) {
    const desk = this.desks.get(accountId);
    const stored = desk?.committed ?? 0n;
    const none = { stored, committed: stored, burn: 0n, unsettled: 0, misses: 0, monthMisses: 0, monthBurn: 0n };
    if (!desk || accountId === this.poolId || !desk.onCall) return none;
    const month = monthOf(nowMs);
    const list = this.#virtualExpired(nowMs);
    let committed = stored;
    let misses = 0;
    let monthMisses = 0;
    let monthBurn = 0n;
    for (let i = desk.cursor; i < list.length; i++) {
      const t = this.tickets[list[i]];
      if (desk.statements.has(t.id)) continue;
      const { burned, balance } = applyMiss(committed, t.burnBps);
      committed = balance;
      misses += 1;
      if (monthOf(t.deadlineMs) === month) {
        monthMisses += 1;
        monthBurn += burned;
      }
    }
    return { stored, committed, burn: stored - committed, unsettled: list.length - desk.cursor, misses, monthMisses, monthBurn };
  }

  /** ft_balance_of: free balance plus the effective committed amount (stored minus the burn settlement would apply). */
  balanceOf(accountId, nowMs) {
    const free = this.balances.get(accountId) ?? 0n;
    if (accountId === this.poolId) return free;
    return free + this.pending(accountId, nowMs).committed;
  }

  /** get_desk, as plain values (BigInt for token amounts). `balance` is the FREE balance. */
  desk(accountId, nowMs) {
    const empty = {
      registered: false, balance: 0n, onCall: false, committed: 0n, storedCommitted: 0n, pendingBurn: 0n,
      unsettled: 0, onTime: 0, missed: 0, streak: 0, bestStreak: 0, burned: 0n, month: 0, monthOnTime: 0,
      monthMissed: 0, monthBurned: 0n, claimedStarter: false, registeredAtMs: 0n, firstOnCallMs: 0n,
      onCallSinceMs: 0n, shiftEndsMs: 0n,
    };
    if (accountId === this.poolId) return { ...empty, registered: true, balance: this.balances.get(this.poolId) ?? 0n };
    const d = this.desks.get(accountId);
    if (!d) return empty;
    const p = this.pending(accountId, nowMs);
    const month = monthOf(nowMs);
    const current = d.month === month;
    return {
      registered: true,
      balance: this.balances.get(accountId) ?? 0n,
      onCall: d.onCall,
      committed: p.committed,
      storedCommitted: p.stored,
      pendingBurn: p.burn,
      unsettled: p.unsettled,
      onTime: d.onTime,
      missed: d.missed + p.misses,
      streak: p.misses > 0 ? 0 : d.streak,
      bestStreak: d.bestStreak,
      burned: d.burned + p.burn,
      month,
      monthOnTime: current ? d.monthOnTime : 0,
      monthMissed: (current ? d.monthMissed : 0) + p.monthMisses,
      monthBurned: (current ? d.monthBurned : 0n) + p.monthBurn,
      claimedStarter: d.claimedStarter,
      registeredAtMs: d.registeredAtMs,
      firstOnCallMs: d.firstOnCallMs,
      onCallSinceMs: d.onCallSinceMs,
      shiftEndsMs: d.onCall ? d.onCallSinceMs + this.minShiftMs : 0n,
    };
  }

  /** get_roster(from_index, limit): desks in the order they first went on call, limit capped at 50. */
  getRoster(fromIndex, limit, nowMs) {
    const n = Math.min(limit, ROSTER_MAX_LIMIT);
    return this.roster.slice(fromIndex, fromIndex + n).map((accountId) => ({ accountId, desk: this.desk(accountId, nowMs) }));
  }

  stats(nowMs) {
    const now = BigInt(nowMs);
    const open = this.openIds.filter((id) => now < this.tickets[id].deadlineMs).length;
    return {
      totalSupply: this.totalSupply,
      initialSupply: this.initialSupply,
      burnedTotal: this.burnedTotal,
      deskPool: this.balances.get(this.poolId) ?? 0n,
      ticketsOpened: this.tickets.length,
      ticketsOpen: open,
      ticketsExpired: this.tickets.length - open,
      statementsTotal: this.statementsTotal,
      accounts: this.desks.size,
      onCall: this.onCallCount,
      committedTotal: this.committedTotal,
      roster: this.roster.length,
      missesTotal: this.missesTotal,
    };
  }

  // ---- internals ------------------------------------------------------------------------------

  #unsettledCount(desk) {
    return desk.onCall ? this.expiredIds.length - desk.cursor : 0;
  }

  /**
   * The monthly counters: an event from a later month starts a new month (counters zeroed), an event from the
   * current month adds, an event from an older month changes only the lifetime counters.
   */
  #applyMonth(desk, eventMonth, { onTime = 0, missed = 0, burned = 0n }) {
    if (eventMonth > desk.month) {
      desk.month = eventMonth;
      desk.monthOnTime = 0;
      desk.monthMissed = 0;
      desk.monthBurned = 0n;
    }
    if (eventMonth === desk.month) {
      desk.monthOnTime += onTime;
      desk.monthMissed += missed;
      desk.monthBurned += burned;
    }
  }

  #settleSome(accountId, limit) {
    const desk = this.desks.get(accountId);
    const result = { settled: 0, remaining: 0, burned: 0n, misses: [] };
    if (!desk || accountId === this.poolId || !desk.onCall) return result;
    while (result.settled < limit && desk.cursor < this.expiredIds.length) {
      const id = this.expiredIds[desk.cursor];
      desk.cursor += 1;
      result.settled += 1;
      if (desk.statements.has(id)) continue;
      const t = this.tickets[id];
      const { burned, balance } = applyMiss(desk.committed, t.burnBps);
      desk.committed = balance;
      this.committedTotal -= burned;
      this.totalSupply -= burned;
      this.burnedTotal += burned;
      this.missesTotal += 1;
      desk.missed += 1;
      desk.streak = 0;
      desk.burned += burned;
      // Settlement can lag; a miss belongs to the month its deadline fell in.
      this.#applyMonth(desk, monthOf(t.deadlineMs), { missed: 1, burned });
      t.missed += 1;
      t.burned += burned;
      result.burned += burned;
      result.misses.push({ ticketId: id, cveId: t.cveId, burned, memo: `missed ${t.cveId}` });
    }
    result.remaining = this.expiredIds.length - desk.cursor;
    return result;
  }
}
