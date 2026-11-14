use near_sdk::json_types::{U64, U128};
use near_sdk::{AccountId, near};

#[near(serializers = [borsh, json])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    NotAffected,
    Fixed,
    Mitigated,
}

#[near(serializers = [borsh, json])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TicketState {
    Open,
    Expired,
}

/// What a reporter attests to. Its borsh bytes are hashed, so every reporter must send the
/// exact same fields for confirmations to add up.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TicketReport {
    pub cve_id: String,
    pub vendor: String,
    pub product: String,
    pub date_added: String,
    pub due_date: String,
    pub ransomware: bool,
    pub deadline_ms: U64,
}

/// Stored as is; views only override `state` for tickets past the deadline that nobody poked yet.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Ticket {
    pub id: u32,
    pub cve_id: String,
    pub vendor: String,
    pub product: String,
    pub date_added: String,
    pub due_date: String,
    pub ransomware: bool,
    pub opened_at_ms: U64,
    pub deadline_ms: U64,
    pub burn_bps: u16,
    pub state: TicketState,
    pub closes: u32,
    pub not_affected: u32,
    pub fixed: u32,
    pub mitigated: u32,
    pub missed: u32,
    pub burned: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Statement {
    pub status: Status,
    pub at_ms: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Config {
    pub reporters: Vec<AccountId>,
    pub quorum: u8,
    pub miss_bps: u16,
    pub ransom_miss_bps: u16,
    pub min_window_ms: U64,
    pub max_open: u16,
    pub starter_bag: U128,
    pub initial_supply: U128,
    /// The smallest amount that starts an on-call stint.
    pub min_commit: U128,
    /// The shortest shift: a desk cannot clock out sooner after going on call.
    pub min_shift_ms: U64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Stats {
    pub total_supply: U128,
    pub initial_supply: U128,
    pub burned_total: U128,
    pub desk_pool: U128,
    pub tickets_opened: u32,
    pub tickets_open: u32,
    pub tickets_expired: u32,
    pub statements_total: u64,
    pub accounts: u64,
    pub now_ms: U64,
    /// Desks on call right now.
    pub on_call: u64,
    /// Stored sum of committed tokens; falls as burns are settled.
    pub committed_total: U128,
    /// Desks that have ever been on call.
    pub roster: u32,
    /// Settled misses, all desks.
    pub misses_total: u64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Desk {
    pub registered: bool,
    /// The free balance: plain NEP-141, never burned, the only part transfers move.
    pub balance: U128,
    pub on_call: bool,
    /// Effective: the stored committed amount minus the pending burn.
    pub committed: U128,
    pub stored_committed: U128,
    pub pending_burn: U128,
    pub unsettled: u32,
    pub on_time: u32,
    /// Lifetime, unsettled misses included.
    pub missed: u32,
    pub streak: u32,
    pub best_streak: u32,
    /// Lifetime, the pending burn included.
    pub burned: U128,
    /// The current month as YYYYMM in UTC; the three counters below are for this month only.
    pub month: u32,
    pub month_on_time: u32,
    pub month_missed: u32,
    pub month_burned: U128,
    pub claimed_starter: bool,
    pub registered_at_ms: U64,
    /// 0 if the desk has never been on call.
    pub first_on_call_ms: U64,
    /// When the current (or last) shift started; 0 if the desk has never been on call.
    pub on_call_since_ms: U64,
    /// `on_call_since_ms + min_shift_ms` while on call, 0 when not on call.
    pub shift_ends_ms: U64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RosterEntry {
    pub account_id: AccountId,
    pub desk: Desk,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SettleResult {
    pub settled: u32,
    pub remaining: u32,
    pub burned: U128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReportResult {
    pub activated: bool,
    pub ticket_id: Option<u32>,
    pub confirmations: u8,
}

/// The stored desk. `idx` keys the account's statements, so a re-registered account starts
/// with a clean record instead of inheriting the old one. `balance` is the free balance;
/// settlement burns only from `committed`, and only while `on_call`.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DeskRecord {
    pub idx: u32,
    pub balance: u128,
    pub cursor: u32,
    pub on_time: u32,
    pub missed: u32,
    pub streak: u32,
    pub best_streak: u32,
    pub burned: u128,
    pub registered_at_ms: u64,
    pub on_call: bool,
    pub committed: u128,
    pub first_on_call_ms: u64,
    /// YYYYMM of the month the three counters below belong to; 0 before the first event.
    pub month: u32,
    pub month_on_time: u32,
    pub month_missed: u32,
    pub month_burned: u128,
    /// Start of the current shift (the last time the desk went from off call to on call).
    pub on_call_since_ms: u64,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Pending {
    pub report: TicketReport,
    pub confirmers: Vec<AccountId>,
}
