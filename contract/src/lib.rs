// KEVIN: a NEP-141 token whose supply reacts to how the community answers real security
// deadlines. Reporters open one ticket per CISA KEV entry (by quorum). Holding KEVIN asks
// nothing; a desk that goes on call commits part of its bag and answers every ticket before the
// deadline or loses a fixed share of what it committed when it is settled. There is no owner,
// admin or upgrade method: the config is fixed at `new`.
use near_sdk::json_types::U128;
use near_sdk::store::{LookupMap, LookupSet, Vector};
use near_sdk::{AccountId, BorshStorageKey, PanicOnDefault, env, near, require};

mod events;
mod expiry;
mod month;
mod oncall;
mod settle;
mod storage;
mod tickets;
mod token;
mod types;
mod views;

#[cfg(test)]
mod tests;

pub use types::*;

/// Hard caps from the spec; they bound the in-state `open` list and the reporter loop.
pub const MAX_REPORTERS: usize = 5;
pub const MAX_OPEN_LIMIT: u16 = 128;
pub const MAX_MISS_BPS: u16 = 1000;
/// The farthest deadline a report may carry. CISA's longest window in the catalog is 184 days.
pub const MAX_WINDOW_MS: u64 = 200 * DAY_MS;
pub const DAY_MS: u64 = 86_400_000;
pub const MAX_RANSOM_MISS_BPS: u16 = 2000;
pub const BPS: u128 = 10_000;
/// Statements prepaid by the registration deposit (about a year of KEV additions); anything
/// beyond is carried by the contract's own balance.
pub const PREPAID_STATEMENTS: u64 = 128;
/// Bytes the protocol charges per stored record on top of its key and value.
const RECORD_OVERHEAD: u64 = 40;

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum Key {
    Expired,
    Tickets,
    ByCve,
    Pending,
    ReporterPending,
    Desks,
    Statements,
    Claimed,
    Roster,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    reporters: Vec<AccountId>,
    quorum: u8,
    miss_bps: u16,
    ransom_miss_bps: u16,
    min_window_ms: u64,
    max_open: u16,
    starter_bag: u128,
    initial_supply: u128,
    total_supply: u128,
    /// The contract account's own balance (the desk pool). It is never settled.
    pool: u128,
    /// (ticket id, deadline_ms) of every open ticket. Kept in the root state so the expiry scan
    /// at the start of every call reads no extra storage.
    open: Vec<(u32, u64)>,
    /// Ticket ids in the order they expired; desks settle by walking it with their cursor.
    expired: Vector<u32>,
    /// Indexed by ticket id.
    tickets: Vector<Ticket>,
    by_cve: LookupMap<String, u32>,
    pending: LookupMap<[u8; 32], Pending>,
    /// Report hashes each reporter has confirmed and that have not activated yet; bounds how much
    /// storage one reporter can make the contract carry.
    reporter_pending: LookupMap<AccountId, Vec<[u8; 32]>>,
    desks: LookupMap<AccountId, DeskRecord>,
    /// Keyed by (desk idx, ticket id).
    statements: LookupMap<(u32, u32), Statement>,
    /// Accounts that took the starter bag.
    claimed: LookupSet<AccountId>,
    next_desk_idx: u32,
    accounts: u64,
    statements_total: u64,
    /// UTC day (`now_ms / 86_400_000`) of the last activation and how many tickets opened that
    /// day; caps how much storage a corrupt quorum can make the contract carry.
    day_index: u64,
    opened_today: u16,
    /// Storage charged at registration: desk, claim marker, roster entry and the prepaid
    /// statements.
    registration_bytes: u64,
    min_commit: u128,
    min_shift_ms: u64,
    /// Desks on call right now.
    on_call_desks: u64,
    /// Sum of the stored committed amounts.
    committed_total: u128,
    /// Every account that has ever gone on call, in the order it first did.
    roster: Vector<AccountId>,
    /// Settled misses, all desks.
    misses_total: u64,
}

#[near]
impl Contract {
    #[init]
    #[private]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        reporters: Vec<AccountId>,
        quorum: u8,
        miss_bps: u16,
        ransom_miss_bps: u16,
        min_window_ms: near_sdk::json_types::U64,
        max_open: u16,
        starter_bag: U128,
        initial_supply: U128,
        min_commit: U128,
        min_shift_ms: near_sdk::json_types::U64,
    ) -> Self {
        require!(
            quorum >= 1 && (quorum as usize) <= reporters.len() && reporters.len() <= MAX_REPORTERS,
            "need 1 <= quorum <= reporters <= 5"
        );
        for (i, r) in reporters.iter().enumerate() {
            require!(!reporters[..i].contains(r), "reporters must be unique");
        }
        require!(miss_bps <= MAX_MISS_BPS, "miss_bps must be at most 1000");
        require!(ransom_miss_bps <= MAX_RANSOM_MISS_BPS, "ransom_miss_bps must be at most 2000");
        require!((1..=MAX_OPEN_LIMIT).contains(&max_open), "max_open must be between 1 and 128");
        require!(min_commit.0 >= 1, "min_commit must be at least 1");

        let registration_bytes = storage_sizes();
        let me = env::current_account_id();
        let this = Self {
            reporters,
            quorum,
            miss_bps,
            ransom_miss_bps,
            min_window_ms: min_window_ms.0,
            max_open,
            starter_bag: starter_bag.0,
            initial_supply: initial_supply.0,
            total_supply: initial_supply.0,
            pool: initial_supply.0,
            open: Vec::new(),
            expired: Vector::new(Key::Expired),
            tickets: Vector::new(Key::Tickets),
            by_cve: LookupMap::new(Key::ByCve),
            pending: LookupMap::new(Key::Pending),
            reporter_pending: LookupMap::new(Key::ReporterPending),
            desks: LookupMap::new(Key::Desks),
            statements: LookupMap::new(Key::Statements),
            claimed: LookupSet::new(Key::Claimed),
            next_desk_idx: 0,
            accounts: 0,
            statements_total: 0,
            day_index: 0,
            opened_today: 0,
            registration_bytes,
            min_commit: min_commit.0,
            min_shift_ms: min_shift_ms.0,
            on_call_desks: 0,
            committed_total: 0,
            roster: Vector::new(Key::Roster),
            misses_total: 0,
        };
        if initial_supply.0 > 0 {
            events::ft_mint(&me, initial_supply.0, "desk pool");
        }
        this
    }
}

/// Record sizes computed from their borsh encodings (key = 1-byte prefix + borsh key), so the
/// registration price matches what the protocol actually charges.
fn storage_sizes() -> u64 {
    let longest = 4 + 64; // borsh string length prefix + the longest account id
    let desk_value = near_sdk::borsh::to_vec(&DeskRecord::default()).unwrap().len() as u64;
    let statement_value =
        near_sdk::borsh::to_vec(&Statement { status: Status::Fixed, at_ms: 0.into() }).unwrap().len() as u64;
    let desk = RECORD_OVERHEAD + 1 + longest + desk_value;
    let claim = RECORD_OVERHEAD + 1 + longest + 1;
    // a Vector element is keyed by its u32 index and holds the borsh account id
    let roster = RECORD_OVERHEAD + 1 + 4 + longest;
    let statement = RECORD_OVERHEAD + 1 + 8 + statement_value;
    desk + claim + roster + PREPAID_STATEMENTS * statement
}

impl Contract {
    pub(crate) fn is_pool(account: &AccountId) -> bool {
        *account == env::current_account_id()
    }

    /// Registered for NEP-141 purposes: a desk, or the contract account itself.
    pub(crate) fn is_holder(&self, account: &AccountId) -> bool {
        Self::is_pool(account) || self.desks.contains_key(account)
    }

    pub(crate) fn stored_balance(&self, account: &AccountId) -> u128 {
        if Self::is_pool(account) { self.pool } else { self.desks.get(account).map_or(0, |d| d.balance) }
    }

    pub(crate) fn set_balance(&mut self, account: &AccountId, balance: u128) {
        if Self::is_pool(account) {
            self.pool = balance;
        } else {
            self.desks.get_mut(account).expect("desk").balance = balance;
        }
    }
}
