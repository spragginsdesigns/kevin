// Views read the clock: a ticket past its deadline is reported expired and its burn is already
// counted in committed amounts and month counters, even before anyone calls `poke`.
use crate::month::month_of;
use crate::{Config, Contract, ContractExt, Desk, RosterEntry, Statement, Stats, Ticket, TicketState};
use near_sdk::json_types::{U64, U128};
use near_sdk::{AccountId, env, near};

const MAX_PAGE: u32 = 100;
/// Every roster entry carries a projected desk, so pages are smaller.
const MAX_ROSTER_PAGE: u32 = 50;

impl Contract {
    fn view_ticket(&self, ticket: &Ticket, now: u64) -> Ticket {
        let mut t = ticket.clone();
        if now >= t.deadline_ms.0 {
            t.state = TicketState::Expired;
        }
        t
    }

    fn open_now(&self, now: u64) -> u32 {
        self.open.iter().filter(|(_, deadline)| now < *deadline).count() as u32
    }
}

#[near]
impl Contract {
    pub fn get_config(&self) -> Config {
        Config {
            reporters: self.reporters.clone(),
            quorum: self.quorum,
            miss_bps: self.miss_bps,
            ransom_miss_bps: self.ransom_miss_bps,
            min_window_ms: U64(self.min_window_ms),
            max_open: self.max_open,
            starter_bag: U128(self.starter_bag),
            initial_supply: U128(self.initial_supply),
            min_commit: U128(self.min_commit),
            min_shift_ms: U64(self.min_shift_ms),
        }
    }

    pub fn get_stats(&self) -> Stats {
        let now = env::block_timestamp_ms();
        let opened = self.tickets.len();
        let open = self.open_now(now);
        Stats {
            total_supply: U128(self.total_supply),
            initial_supply: U128(self.initial_supply),
            burned_total: U128(self.initial_supply - self.total_supply),
            desk_pool: U128(self.pool),
            tickets_opened: opened,
            tickets_open: open,
            tickets_expired: opened - open,
            statements_total: self.statements_total,
            accounts: self.accounts,
            now_ms: U64(now),
            on_call: self.on_call_desks,
            committed_total: U128(self.committed_total),
            roster: self.roster.len(),
            misses_total: self.misses_total,
        }
    }

    pub fn get_ticket(&self, ticket_id: u32) -> Option<Ticket> {
        let now = env::block_timestamp_ms();
        self.tickets.get(ticket_id).map(|t| self.view_ticket(t, now))
    }

    pub fn get_ticket_by_cve(&self, cve_id: String) -> Option<Ticket> {
        self.by_cve.get(&cve_id).and_then(|&id| self.get_ticket(id))
    }

    /// Ticket ids are their index, so `from_index` is also the first id returned.
    pub fn get_tickets(&self, from_index: u32, limit: u32) -> Vec<Ticket> {
        let now = env::block_timestamp_ms();
        let end = from_index.saturating_add(limit.min(MAX_PAGE)).min(self.tickets.len());
        (from_index..end).filter_map(|id| self.tickets.get(id)).map(|t| self.view_ticket(t, now)).collect()
    }

    /// Deadline ascending, then id.
    pub fn get_open_tickets(&self) -> Vec<Ticket> {
        let now = env::block_timestamp_ms();
        let mut open: Vec<(u64, u32)> =
            self.open.iter().filter(|(_, deadline)| now < *deadline).map(|(id, deadline)| (*deadline, *id)).collect();
        open.sort_unstable();
        open.into_iter().filter_map(|(_, id)| self.tickets.get(id)).map(|t| self.view_ticket(t, now)).collect()
    }

    /// The committed amount, misses, streak, burned and this month's counters are projected as
    /// if settlement ran now; the stored amount is in `stored_committed` and the difference in
    /// `pending_burn`. The free balance never has anything pending.
    pub fn get_desk(&self, account_id: AccountId) -> Desk {
        let claimed_starter = self.claimed.contains(&account_id);
        if Self::is_pool(&account_id) {
            return Desk { registered: true, balance: U128(self.pool), claimed_starter, ..Desk::default() };
        }
        let Some(d) = self.desks.get(&account_id) else {
            return Desk { claimed_starter, ..Desk::default() };
        };
        let now = env::block_timestamp_ms();
        let p = self.project(d, now);
        let month = month_of(now);
        let (on_time, missed, burned) =
            if d.month == month { (d.month_on_time, d.month_missed, d.month_burned) } else { (0, 0, 0) };
        Desk {
            registered: true,
            balance: U128(d.balance),
            on_call: d.on_call,
            committed: U128(p.committed),
            stored_committed: U128(d.committed),
            pending_burn: U128(p.pending_burn),
            unsettled: p.unsettled,
            on_time: d.on_time,
            missed: d.missed + p.pending_misses,
            streak: if p.pending_misses > 0 { 0 } else { d.streak },
            best_streak: d.best_streak,
            burned: U128(d.burned + p.pending_burn),
            month,
            month_on_time: on_time,
            month_missed: missed + p.month_misses,
            month_burned: U128(burned + p.month_burn),
            claimed_starter,
            registered_at_ms: U64(d.registered_at_ms),
            first_on_call_ms: U64(d.first_on_call_ms),
            on_call_since_ms: U64(d.on_call_since_ms),
            shift_ends_ms: U64(if d.on_call { d.on_call_since_ms.saturating_add(self.min_shift_ms) } else { 0 }),
        }
    }

    /// The roster's account ids only, in the same order, with no projection, so it stays cheap
    /// however far behind any desk is. `limit` is capped at 100.
    pub fn get_roster_accounts(&self, from_index: u32, limit: u32) -> Vec<AccountId> {
        let end = from_index.saturating_add(limit.min(MAX_PAGE)).min(self.roster.len());
        (from_index..end).filter_map(|i| self.roster.get(i).cloned()).collect()
    }

    /// Every desk that has ever been on call, in the order it first went on call, with the
    /// same desk `get_desk` returns. `limit` is capped at 50.
    pub fn get_roster(&self, from_index: u32, limit: u32) -> Vec<RosterEntry> {
        let end = from_index.saturating_add(limit.min(MAX_ROSTER_PAGE)).min(self.roster.len());
        (from_index..end)
            .filter_map(|i| self.roster.get(i))
            .map(|account_id| RosterEntry { desk: self.get_desk(account_id.clone()), account_id: account_id.clone() })
            .collect()
    }

    pub fn get_statement(&self, account_id: AccountId, ticket_id: u32) -> Option<Statement> {
        let idx = self.desks.get(&account_id)?.idx;
        self.statements.get(&(idx, ticket_id)).copied()
    }

    pub fn get_statements(&self, account_id: AccountId, ticket_ids: Vec<u32>) -> Vec<Option<Statement>> {
        let Some(idx) = self.desks.get(&account_id).map(|d| d.idx) else {
            return vec![None; ticket_ids.len()];
        };
        ticket_ids.into_iter().map(|id| self.statements.get(&(idx, id)).copied()).collect()
    }
}
