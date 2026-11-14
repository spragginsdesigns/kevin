// NEP-297 logs. Every event is written as one log line whose `data` is an array, so a settlement
// that burns many tickets costs two lines, not two per ticket. The protocol caps a receipt at
// 100 log lines and 16384 log bytes; going over aborts the whole call, so the bytes written so
// far are tracked here and settlement stops early instead of failing. Modified ticket records
// are counted too, so settlement keeps enough gas to write them back when the call returns.
use near_sdk::serde_json::{Value, json};
use near_sdk::{AccountId, env};
use std::cell::Cell;

pub const KEVIN: &str = "kevin";
pub const NEP141: &str = "nep141";
/// Wallets and explorers filter NEP-141 events on the version, so they stay at 1.0.0; only the
/// `kevin` events moved to 2.0.0.
pub const NEP141_VERSION: &str = "1.0.0";
pub const KEVIN_VERSION: &str = "2.0.0";

/// The protocol's per-receipt log byte limit.
const LOG_LIMIT: usize = 16_384;
/// Kept free after settlement for the call's own events (a transfer, a statement).
const LOG_RESERVE: usize = 1_024;
/// Upper bound on the `EVENT_JSON:{...,"data":[]}` wrapper of one line.
pub const HEADER_BYTES: usize = 96;

thread_local! {
    static USED: Cell<usize> = const { Cell::new(0) };
    static TOUCHED: Cell<u64> = const { Cell::new(0) };
}

/// Called once at the start of every change method: a receipt starts with no logs and no
/// modified tickets.
pub fn reset() {
    USED.with(|u| u.set(0));
    TOUCHED.with(|t| t.set(0));
}

/// Ticket records modified in this receipt. They are only written back when the call returns,
/// so the gas for that write-back has to stay unspent until then.
pub fn touch() {
    TOUCHED.with(|t| t.set(t.get() + 1));
}

pub fn touched() -> u64 {
    TOUCHED.with(|t| t.get())
}

/// Whether `extra` more bytes of logs still fit before the reserve.
pub fn fits(extra: usize) -> bool {
    USED.with(|u| u.get()) + extra + LOG_RESERVE <= LOG_LIMIT
}

pub fn emit(standard: &str, event: &str, items: &[String]) {
    if items.is_empty() {
        return;
    }
    let version = if standard == NEP141 { NEP141_VERSION } else { KEVIN_VERSION };
    let line = format!(
        "EVENT_JSON:{{\"standard\":\"{standard}\",\"version\":\"{version}\",\"event\":\"{event}\",\"data\":[{}]}}",
        items.join(",")
    );
    USED.with(|u| u.set(u.get() + line.len()));
    env::log_str(&line);
}

pub fn item(v: Value) -> String {
    v.to_string()
}

pub fn ft_mint(owner: &AccountId, amount: u128, memo: &str) {
    emit(NEP141, "ft_mint", &[item(json!({ "owner_id": owner, "amount": amount.to_string(), "memo": memo }))]);
}

pub fn ft_transfer(from: &AccountId, to: &AccountId, amount: u128, memo: Option<&str>) {
    let mut v = json!({ "old_owner_id": from, "new_owner_id": to, "amount": amount.to_string() });
    if let Some(m) = memo {
        v["memo"] = json!(m);
    }
    emit(NEP141, "ft_transfer", &[item(v)]);
}

pub fn ft_burn_item(owner: &AccountId, amount: u128, memo: &str) -> String {
    item(json!({ "owner_id": owner, "amount": amount.to_string(), "memo": memo }))
}

pub fn missed_item(account: &AccountId, ticket_id: u32, cve_id: &str, burned: u128) -> String {
    item(json!({ "account_id": account, "ticket_id": ticket_id, "cve_id": cve_id, "burned": burned.to_string() }))
}

pub fn ticket_opened(ticket_id: u32, cve_id: &str, deadline_ms: u64, burn_bps: u16) {
    emit(
        KEVIN,
        "ticket_opened",
        &[item(json!({
            "ticket_id": ticket_id, "cve_id": cve_id, "deadline_ms": deadline_ms.to_string(), "burn_bps": burn_bps
        }))],
    );
}

pub fn ticket_expired_item(ticket_id: u32, cve_id: &str) -> String {
    item(json!({ "ticket_id": ticket_id, "cve_id": cve_id }))
}

pub fn statement(account: &AccountId, ticket_id: u32, cve_id: &str, status: crate::Status, at_ms: u64) {
    emit(
        KEVIN,
        "statement",
        &[item(json!({
            "account_id": account, "ticket_id": ticket_id, "cve_id": cve_id, "status": status, "at_ms": at_ms.to_string()
        }))],
    );
}

pub fn on_call(account: &AccountId, amount: u128, committed: u128) {
    emit(
        KEVIN,
        "on_call",
        &[item(json!({ "account_id": account, "amount": amount.to_string(), "committed": committed.to_string() }))],
    );
}

pub fn clocked_out(account: &AccountId, returned: u128) {
    emit(KEVIN, "clocked_out", &[item(json!({ "account_id": account, "returned": returned.to_string() }))]);
}
