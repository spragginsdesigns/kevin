// The mechanic. A desk on call walks `expired` with its cursor; every ticket it did not answer
// burns `floor(committed * burn_bps / 10000)` of what it has committed at that point, so misses
// compound in expiry order. The free balance is never touched, and committed tokens cannot be
// transferred, so there is nothing to move around.
use crate::events::{self, HEADER_BYTES, KEVIN, NEP141};
use crate::month::{count_month, month_of};
use crate::{BPS, Contract, ContractExt, DeskRecord, SettleResult};
use near_sdk::json_types::U128;
use near_sdk::{AccountId, Gas, env, near};

pub const DEFAULT_SETTLE: u32 = 50;
pub const MAX_SETTLE: u32 = 200;
/// Left unspent by a settlement loop so the call can still write state and finish: a fixed part
/// for the desk, the logs and the root state, plus one ticket write-back for every ticket
/// modified so far in the receipt (and the one about to be).
const GAS_RESERVE_BASE: Gas = Gas::from_tgas(5);
const GAS_PER_TICKET_WRITE: Gas = Gas::from_ggas(150);

fn gas_reserve() -> Gas {
    GAS_RESERVE_BASE.saturating_add(GAS_PER_TICKET_WRITE.saturating_mul(events::touched() + 1))
}

pub fn miss_burn(committed: u128, burn_bps: u16) -> u128 {
    committed * burn_bps as u128 / BPS
}

/// What settling everything due right now would do to a desk; nothing is written.
pub struct Projection {
    pub committed: u128,
    pub pending_burn: u128,
    pub pending_misses: u32,
    pub unsettled: u32,
    /// The pending misses (and their burn) whose deadline is in the current month.
    pub month_misses: u32,
    pub month_burn: u128,
}

impl Contract {
    /// Settles up to `limit` expired tickets for `account`, stopping early when gas or the
    /// receipt's log budget runs low. Only desks on call are settled; the pool, unknown accounts
    /// and desks off call never are. Returns (entries settled, tokens burned).
    pub(crate) fn settle_account(&mut self, account: &AccountId, limit: u32) -> (u32, u128) {
        if Self::is_pool(account) {
            return (0, 0);
        }
        let Some(mut desk) = self.desks.get(account).filter(|d| d.on_call).cloned() else {
            return (0, 0);
        };
        let total = self.expired.len();
        let (mut settled, mut burned) = (0u32, 0u128);
        let (mut misses, mut burns) = (Vec::new(), Vec::new());
        let mut log_bytes = 2 * HEADER_BYTES;
        while settled < limit && desk.cursor < total {
            if env::prepaid_gas().saturating_sub(env::used_gas()) < gas_reserve() {
                break;
            }
            let ticket_id = *self.expired.get(desk.cursor).expect("cursor in range");
            if !self.statements.contains_key(&(desk.idx, ticket_id)) {
                let ticket = self.tickets.get_mut(ticket_id).expect("expired ticket exists");
                let burn = miss_burn(desk.committed, ticket.burn_bps);
                let missed = events::missed_item(account, ticket_id, &ticket.cve_id, burn);
                let burn_log =
                    (burn > 0).then(|| events::ft_burn_item(account, burn, &format!("missed {}", ticket.cve_id)));
                let extra = missed.len() + 1 + burn_log.as_ref().map_or(0, |b| b.len() + 1);
                if !events::fits(log_bytes + extra) {
                    break;
                }
                log_bytes += extra;
                events::touch();
                ticket.missed += 1;
                ticket.burned = U128(ticket.burned.0 + burn);
                desk.committed -= burn;
                desk.burned += burn;
                desk.missed += 1;
                desk.streak = 0;
                // the miss belongs to the month its deadline fell in, however late it settles
                count_month(&mut desk, month_of(ticket.deadline_ms.0), 0, 1, burn);
                self.total_supply -= burn;
                self.committed_total -= burn;
                self.misses_total += 1;
                burned += burn;
                misses.push(missed);
                burns.extend(burn_log);
            }
            desk.cursor += 1;
            settled += 1;
        }
        if settled > 0 {
            self.desks.insert(account.clone(), desk);
        }
        events::emit(NEP141, "ft_burn", &burns);
        events::emit(KEVIN, "missed", &misses);
        (settled, burned)
    }

    /// Unsettled expired tickets of a desk on call; 0 for anyone else.
    pub(crate) fn unsettled(&self, account: &AccountId) -> u32 {
        if Self::is_pool(account) {
            return 0;
        }
        self.desks.get(account).filter(|d| d.on_call).map_or(0, |d| self.expired.len() - d.cursor)
    }

    pub(crate) fn behind(&self, account: &AccountId) -> bool {
        self.unsettled(account) > 0
    }

    /// The settle-first rule for every method that changes a committed amount.
    pub(crate) fn settle_or_panic(&mut self, account: &AccountId) {
        self.settle_account(account, DEFAULT_SETTLE);
        if self.behind(account) {
            env::panic_str("account behind: call settle first");
        }
    }

    /// Replays settlement in memory, including tickets past their deadline that nobody has
    /// expired yet, in the same order and with the same floor math as `settle_account`. A desk
    /// off call has nothing pending.
    pub(crate) fn project(&self, desk: &DeskRecord, now: u64) -> Projection {
        let mut p = Projection {
            committed: desk.committed,
            pending_burn: 0,
            pending_misses: 0,
            unsettled: 0,
            month_misses: 0,
            month_burn: 0,
        };
        if !desk.on_call {
            return p;
        }
        let month = month_of(now);
        let stored = (desk.cursor..self.expired.len()).map(|i| *self.expired.get(i).expect("in range"));
        for ticket_id in stored.chain(self.due(now)) {
            p.unsettled += 1;
            if !self.statements.contains_key(&(desk.idx, ticket_id)) {
                let ticket = self.tickets.get(ticket_id).expect("ticket");
                let burn = miss_burn(p.committed, ticket.burn_bps);
                p.committed -= burn;
                p.pending_burn += burn;
                p.pending_misses += 1;
                if month_of(ticket.deadline_ms.0) == month {
                    p.month_misses += 1;
                    p.month_burn += burn;
                }
            }
        }
        p
    }
}

#[near]
impl Contract {
    /// Permissionless: anyone may settle anyone, so burns cannot be dodged by never transacting.
    /// A no-op for desks off call, the pool and unknown accounts.
    pub fn settle(&mut self, account_id: AccountId, limit: Option<u32>) -> SettleResult {
        self.run_expiry();
        let limit = limit.unwrap_or(DEFAULT_SETTLE).min(MAX_SETTLE);
        let (settled, burned) = self.settle_account(&account_id, limit);
        SettleResult { settled, remaining: self.unsettled(&account_id), burned: U128(burned) }
    }
}
