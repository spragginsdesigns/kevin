// Unit tests: every rule and every panic string of the spec against a mocked chain. The
// near-sandbox tests in tests/ run the same rules on the real wasm.
use super::*;
use crate::settle::miss_burn;
use near_contract_standards::fungible_token::core::FungibleTokenCore;
use near_contract_standards::fungible_token::metadata::FungibleTokenMetadataProvider;
use near_contract_standards::fungible_token::resolver::FungibleTokenResolver;
use near_contract_standards::storage_management::StorageManagement;
use near_sdk::json_types::U64;
use near_sdk::serde_json::{self, Value, json};
use near_sdk::test_utils::{VMContextBuilder, get_logs};
use near_sdk::{NearToken, PromiseResult, RuntimeFeesConfig, testing_env};

const MS: u64 = 1_000_000;
const KEV: u128 = 1_000_000_000_000_000_000;
const BAG: u128 = 10_000 * KEV;
const SUPPLY: u128 = 1_000_000_000 * KEV;
const MIN: u128 = 1_000 * KEV;
const HOUR: u64 = 3_600_000;
const DAY: u64 = 86_400_000;
const T0: u64 = 1_800_000_000_000;
const ME: &str = "kevin.testnet";

fn acct(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn context(who: &str, t_ms: u64, deposit: u128) -> VMContextBuilder {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acct(ME))
        .predecessor_account_id(acct(who))
        .signer_account_id(acct(who))
        .block_timestamp(t_ms * MS)
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .account_balance(NearToken::from_near(1_000_000));
    b
}

fn at(who: &str, t_ms: u64, deposit: u128) {
    testing_env!(context(who, t_ms, deposit).build());
}

fn with_result(who: &str, t_ms: u64, result: PromiseResult) {
    testing_env!(
        context(who, t_ms, 0).build(),
        near_sdk::test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![result],
    );
}

fn reporters() -> Vec<AccountId> {
    vec![acct("r1.testnet"), acct("r2.testnet"), acct("r3.testnet")]
}

fn new_contract(quorum: u8, max_open: u16, min_commit: u128, min_shift_ms: u64) -> Contract {
    at(ME, T0, 0);
    Contract::new(
        reporters(),
        quorum,
        100,
        500,
        U64(HOUR),
        max_open,
        U128(BAG),
        U128(SUPPLY),
        U128(min_commit),
        U64(min_shift_ms),
    )
}

/// No minimum shift, so tests that are not about it can clock out at once.
fn setup_with(quorum: u8, max_open: u16) -> Contract {
    new_contract(quorum, max_open, MIN, 0)
}

fn setup() -> Contract {
    setup_with(2, 8)
}

fn report(cve: &str, deadline_ms: u64, ransomware: bool) -> TicketReport {
    TicketReport {
        cve_id: cve.to_string(),
        vendor: "Acme".to_string(),
        product: "Widget Server".to_string(),
        date_added: "2026-11-13".to_string(),
        due_date: "2026-12-04".to_string(),
        ransomware,
        deadline_ms: U64(deadline_ms),
    }
}

/// Opens a ticket through the quorum at time `t` (two confirmations unless quorum is 1).
fn open_at(c: &mut Contract, t: u64, cve: &str, deadline: u64, ransomware: bool) -> u32 {
    at("r1.testnet", t, 0);
    let r = c.report_ticket(report(cve, deadline, ransomware));
    if r.activated {
        return r.ticket_id.unwrap();
    }
    at("r2.testnet", t, 0);
    let r = c.report_ticket(report(cve, deadline, ransomware));
    assert!(r.activated);
    r.ticket_id.unwrap()
}

fn open(c: &mut Contract, cve: &str, deadline: u64, ransomware: bool) -> u32 {
    open_at(c, T0, cve, deadline, ransomware)
}

fn min_deposit(c: &Contract) -> u128 {
    c.storage_balance_bounds().min.as_yoctonear()
}

fn register_at(c: &mut Contract, who: &str, t: u64) {
    let d = min_deposit(c);
    at(who, t, d);
    c.storage_deposit(None, None);
}

fn register(c: &mut Contract, who: &str) {
    register_at(c, who, T0);
}

/// Registered with the starter bag.
fn holder(c: &mut Contract, who: &str) {
    register(c, who);
    at(who, T0, 0);
    assert_eq!(c.claim_starter().0, BAG);
}

fn on_call(c: &mut Contract, who: &str, amount: u128, t: u64) -> Desk {
    at(who, t, 1);
    c.go_on_call(U128(amount))
}

/// Registered with the starter bag, all of it committed.
fn pager(c: &mut Contract, who: &str) {
    holder(c, who);
    on_call(c, who, BAG, T0);
}

fn transfer(c: &mut Contract, from: &str, to: &str, amount: u128, t: u64) {
    at(from, t, 1);
    c.ft_transfer(acct(to), U128(amount), None);
}

fn bal(c: &Contract, who: &str) -> u128 {
    c.ft_balance_of(acct(who)).0
}

fn close(c: &mut Contract, who: &str, id: u32, status: Status, t: u64) -> Statement {
    at(who, t, 0);
    c.close_ticket(id, status)
}

fn event_lines(kind: &str) -> Vec<String> {
    get_logs().into_iter().filter(|l| l.contains(&format!("\"event\":\"{kind}\""))).collect()
}

/// The `data` items of every logged event named `kind`, after checking the NEP-297 envelope.
fn events(standard: &str, kind: &str) -> Vec<Value> {
    get_logs()
        .iter()
        .map(|l| serde_json::from_str::<Value>(l.strip_prefix("EVENT_JSON:").expect("NEP-297 prefix")).unwrap())
        .filter(|v| v["event"] == kind)
        .flat_map(|v| {
            let version = if standard == "nep141" { "1.0.0" } else { "2.0.0" };
            assert_eq!((v["standard"].as_str(), v["version"].as_str()), (Some(standard), Some(version)));
            v["data"].as_array().unwrap().clone()
        })
        .collect()
}

// ---------- init ----------

#[test]
fn init_mints_initial_supply_to_the_desk_pool() {
    let c = setup();
    assert_eq!(get_logs().len(), 1);
    assert_eq!(
        events("nep141", "ft_mint"),
        vec![json!({ "owner_id": ME, "amount": SUPPLY.to_string(), "memo": "desk pool" })]
    );
    assert_eq!(c.ft_total_supply().0, SUPPLY);
    assert_eq!(bal(&c, ME), SUPPLY);
    let s = c.get_stats();
    assert_eq!((s.desk_pool.0, s.initial_supply.0, s.burned_total.0, s.accounts), (SUPPLY, SUPPLY, 0, 0));
    assert_eq!((s.on_call, s.committed_total.0, s.roster, s.misses_total), (0, 0, 0, 0));
    let cfg = c.get_config();
    assert_eq!(cfg.reporters, reporters());
    assert_eq!((cfg.quorum, cfg.miss_bps, cfg.ransom_miss_bps, cfg.max_open), (2, 100, 500, 8));
    assert_eq!((cfg.min_window_ms.0, cfg.starter_bag.0, cfg.initial_supply.0), (HOUR, BAG, SUPPLY));
    assert_eq!((cfg.min_commit.0, cfg.min_shift_ms.0), (MIN, 0));
    let m = c.ft_metadata();
    assert_eq!(
        (m.name.as_str(), m.symbol.as_str(), m.decimals, m.spec.as_str()),
        ("Kevin from IT", "KEVIN", 18, "ft-1.0.0")
    );
}

fn init_min(reps: Vec<&str>, quorum: u8, miss: u16, ransom: u16, max_open: u16, min_commit: u128) {
    at(ME, T0, 0);
    Contract::new(
        reps.into_iter().map(acct).collect(),
        quorum,
        miss,
        ransom,
        U64(HOUR),
        max_open,
        U128(BAG),
        U128(SUPPLY),
        U128(min_commit),
        U64(DAY),
    );
}

fn init(reps: Vec<&str>, quorum: u8, miss: u16, ransom: u16, max_open: u16) {
    init_min(reps, quorum, miss, ransom, max_open, MIN);
}

#[test]
#[should_panic(expected = "need 1 <= quorum <= reporters <= 5")]
fn init_rejects_zero_quorum() {
    init(vec!["a.testnet"], 0, 100, 500, 8);
}

#[test]
#[should_panic(expected = "need 1 <= quorum <= reporters <= 5")]
fn init_rejects_quorum_above_reporters() {
    init(vec!["a.testnet", "b.testnet"], 3, 100, 500, 8);
}

#[test]
#[should_panic(expected = "need 1 <= quorum <= reporters <= 5")]
fn init_rejects_six_reporters() {
    init(vec!["a.testnet", "b.testnet", "c.testnet", "d.testnet", "e.testnet", "f.testnet"], 2, 100, 500, 8);
}

#[test]
#[should_panic(expected = "reporters must be unique")]
fn init_rejects_duplicate_reporters() {
    init(vec!["a.testnet", "a.testnet"], 1, 100, 500, 8);
}

#[test]
#[should_panic(expected = "miss_bps must be at most 1000")]
fn init_rejects_miss_bps_above_1000() {
    init(vec!["a.testnet"], 1, 1001, 500, 8);
}

#[test]
#[should_panic(expected = "ransom_miss_bps must be at most 2000")]
fn init_rejects_ransom_bps_above_2000() {
    init(vec!["a.testnet"], 1, 100, 2001, 8);
}

#[test]
#[should_panic(expected = "max_open must be between 1 and 128")]
fn init_rejects_zero_max_open() {
    init(vec!["a.testnet"], 1, 100, 500, 0);
}

#[test]
#[should_panic(expected = "max_open must be between 1 and 128")]
fn init_rejects_max_open_above_128() {
    init(vec!["a.testnet"], 1, 100, 500, 129);
}

#[test]
#[should_panic(expected = "min_commit must be at least 1")]
fn init_rejects_zero_min_commit() {
    init_min(vec!["a.testnet"], 1, 100, 500, 8, 0);
}

#[test]
fn init_accepts_the_limits() {
    init(vec!["a.testnet", "b.testnet", "c.testnet", "d.testnet", "e.testnet"], 5, 1000, 2000, 128);
    init_min(vec!["a.testnet"], 1, 100, 500, 8, 1);
}

// ---------- report_ticket ----------

#[test]
#[should_panic(expected = "not a reporter")]
fn non_reporter_cannot_report() {
    let mut c = setup();
    at("mallory.testnet", T0, 0);
    c.report_ticket(report("CVE-2026-1234", T0 + 2 * HOUR, false));
}

#[test]
fn cve_id_format() {
    for ok in ["CVE-2026-1", "CVE-2026-12345", "CVE-2021-44228", "CVE-2026-12345678901234"] {
        assert!(tickets::valid_cve(ok), "{ok}");
    }
    assert_eq!("CVE-2026-12345678901234".len(), 23);
    for bad in [
        "",
        "CVE-2026-",
        "cve-2026-1234",
        "CVE-26-1234",
        "CVE-2026_1234",
        "CVE-2026-12a4",
        "CVE-20x6-1234",
        "CVE-2026-1234 ",
        "CVE-2026-1234567890123456",
        "XCVE-2026-1234",
    ] {
        assert!(!tickets::valid_cve(bad), "{bad}");
    }
}

#[test]
#[should_panic(expected = "bad cve id")]
fn report_rejects_bad_cve() {
    let mut c = setup();
    at("r1.testnet", T0, 0);
    c.report_ticket(report("CVE-2026-12345678901234567", T0 + 2 * HOUR, false));
}

#[test]
#[should_panic(expected = "field too long")]
fn report_rejects_long_vendor() {
    let mut c = setup();
    at("r1.testnet", T0, 0);
    let mut r = report("CVE-2026-1234", T0 + 2 * HOUR, false);
    r.vendor = "v".repeat(81);
    c.report_ticket(r);
}

#[test]
#[should_panic(expected = "field too long")]
fn report_rejects_long_product() {
    let mut c = setup();
    at("r1.testnet", T0, 0);
    let mut r = report("CVE-2026-1234", T0 + 2 * HOUR, false);
    r.product = "é".repeat(41); // 82 bytes, 41 chars: the limit is bytes
    c.report_ticket(r);
}

#[test]
#[should_panic(expected = "field too long")]
fn report_rejects_short_date() {
    let mut c = setup();
    at("r1.testnet", T0, 0);
    let mut r = report("CVE-2026-1234", T0 + 2 * HOUR, false);
    r.date_added = "2026-1-13".to_string();
    c.report_ticket(r);
}

#[test]
#[should_panic(expected = "field too long")]
fn report_rejects_long_due_date() {
    let mut c = setup();
    at("r1.testnet", T0, 0);
    let mut r = report("CVE-2026-1234", T0 + 2 * HOUR, false);
    r.due_date = "2026-12-04Z".to_string();
    c.report_ticket(r);
}

#[test]
fn report_accepts_80_byte_names() {
    let mut c = setup_with(1, 8);
    at("r1.testnet", T0, 0);
    let mut r = report("CVE-2026-1234", T0 + 2 * HOUR, false);
    r.vendor = "v".repeat(80);
    r.product = "p".repeat(80);
    assert!(c.report_ticket(r).activated);
}

#[test]
fn quorum_opens_ticket_with_the_config_burn_rate() {
    let mut c = setup();
    let deadline = T0 + 2 * HOUR;
    at("r1.testnet", T0, 0);
    let r = c.report_ticket(report("CVE-2026-1111", deadline, false));
    assert_eq!(r, ReportResult { activated: false, ticket_id: None, confirmations: 1 });
    assert!(c.get_ticket_by_cve("CVE-2026-1111".into()).is_none(), "one reporter alone opens nothing");
    at("r2.testnet", T0 + 5, 0);
    let r = c.report_ticket(report("CVE-2026-1111", deadline, false));
    assert_eq!(r, ReportResult { activated: true, ticket_id: Some(0), confirmations: 2 });
    assert_eq!(
        events("kevin", "ticket_opened"),
        vec![
            json!({ "ticket_id": 0, "cve_id": "CVE-2026-1111", "deadline_ms": deadline.to_string(), "burn_bps": 100 })
        ]
    );
    let t = c.get_ticket(0).unwrap();
    assert_eq!((t.burn_bps, t.state, t.opened_at_ms.0, t.deadline_ms.0), (100, TicketState::Open, T0 + 5, deadline));
    assert_eq!(
        (t.vendor.as_str(), t.product.as_str(), t.date_added.as_str(), t.due_date.as_str()),
        ("Acme", "Widget Server", "2026-11-13", "2026-12-04")
    );
    let id = open(&mut c, "CVE-2026-2222", deadline, true);
    assert_eq!(id, 1);
    let t = c.get_ticket(1).unwrap();
    assert!(t.ransomware);
    assert_eq!(t.burn_bps, 500, "ransomware tickets burn ransom_miss_bps");
    assert_eq!(c.get_ticket_by_cve("CVE-2026-2222".into()).unwrap().id, 1);
}

#[test]
fn quorum_one_opens_on_the_first_report() {
    let mut c = setup_with(1, 8);
    at("r3.testnet", T0, 0);
    let r = c.report_ticket(report("CVE-2026-1111", T0 + 2 * HOUR, false));
    assert_eq!(r, ReportResult { activated: true, ticket_id: Some(0), confirmations: 1 });
}

#[test]
fn reports_that_differ_in_any_field_do_not_add_up() {
    let mut c = setup();
    at("r1.testnet", T0, 0);
    assert_eq!(c.report_ticket(report("CVE-2026-1111", T0 + 2 * HOUR, false)).confirmations, 1);
    at("r2.testnet", T0, 0);
    // the same CVE with a different deadline or ransomware flag is a different report
    assert_eq!(c.report_ticket(report("CVE-2026-1111", T0 + 3 * HOUR, false)).confirmations, 1);
    at("r3.testnet", T0, 0);
    assert_eq!(c.report_ticket(report("CVE-2026-1111", T0 + 2 * HOUR, true)).confirmations, 1);
    assert!(c.get_ticket_by_cve("CVE-2026-1111".into()).is_none());
    at("r2.testnet", T0, 0);
    assert!(c.report_ticket(report("CVE-2026-1111", T0 + 2 * HOUR, false)).activated);
}

#[test]
#[should_panic(expected = "already confirmed")]
fn reporter_cannot_confirm_twice() {
    let mut c = setup();
    at("r1.testnet", T0, 0);
    c.report_ticket(report("CVE-2026-1111", T0 + 2 * HOUR, false));
    at("r1.testnet", T0 + 1000, 0);
    c.report_ticket(report("CVE-2026-1111", T0 + 2 * HOUR, false));
}

#[test]
#[should_panic(expected = "ticket exists")]
fn duplicate_cve_is_refused() {
    let mut c = setup();
    open(&mut c, "CVE-2026-1111", T0 + 2 * HOUR, false);
    at("r3.testnet", T0, 0);
    c.report_ticket(report("CVE-2026-1111", T0 + 5 * HOUR, false));
}

#[test]
#[should_panic(expected = "ticket exists")]
fn duplicate_cve_is_refused_after_expiry() {
    let mut c = setup();
    open(&mut c, "CVE-2026-1111", T0 + 2 * HOUR, false);
    at("r1.testnet", T0 + 3 * HOUR, 0);
    c.report_ticket(report("CVE-2026-1111", T0 + 9 * HOUR, false));
}

#[test]
#[should_panic(expected = "window too short")]
fn deadline_under_the_minimum_window_is_refused() {
    let mut c = setup();
    at("r1.testnet", T0, 0);
    c.report_ticket(report("CVE-2026-1111", T0 + HOUR - 1, false));
}

#[test]
fn deadline_exactly_at_the_minimum_window_is_accepted() {
    let mut c = setup_with(1, 8);
    at("r1.testnet", T0, 0);
    assert!(c.report_ticket(report("CVE-2026-1111", T0 + HOUR, false)).activated);
}

#[test]
#[should_panic(expected = "window too short")]
fn window_is_checked_again_on_every_confirmation() {
    let mut c = setup();
    at("r1.testnet", T0, 0);
    c.report_ticket(report("CVE-2026-1111", T0 + 2 * HOUR, false));
    at("r2.testnet", T0 + HOUR + 1, 0);
    c.report_ticket(report("CVE-2026-1111", T0 + 2 * HOUR, false));
}

#[test]
#[should_panic(expected = "too many open tickets")]
fn max_open_bounds_open_tickets() {
    let mut c = setup_with(2, 2);
    open(&mut c, "CVE-2026-0001", T0 + 2 * HOUR, false);
    open(&mut c, "CVE-2026-0002", T0 + 2 * HOUR, false);
    open(&mut c, "CVE-2026-0003", T0 + 2 * HOUR, false);
}

#[test]
fn max_open_frees_a_slot_when_a_ticket_expires() {
    let mut c = setup_with(2, 2);
    open(&mut c, "CVE-2026-0001", T0 + 2 * HOUR, false);
    open(&mut c, "CVE-2026-0002", T0 + 3 * HOUR, false);
    // the next UTC day, so the daily cap (also max_open) has reset
    let id = open_at(&mut c, T0 + DAY, "CVE-2026-0003", T0 + DAY + 2 * HOUR, false);
    assert_eq!(id, 2);
    assert_eq!(c.get_ticket(0).unwrap().state, TicketState::Expired);
}

#[test]
#[should_panic(expected = "too many pending reports")]
fn one_reporter_cannot_pile_up_pending_reports() {
    let mut c = setup_with(2, 3);
    at("r1.testnet", T0, 0);
    for i in 0..4 {
        c.report_ticket(report(&format!("CVE-2026-000{i}"), T0 + 2 * HOUR, false));
    }
}

#[test]
fn dead_pending_reports_stop_counting() {
    let mut c = setup_with(2, 2);
    at("r1.testnet", T0, 0);
    c.report_ticket(report("CVE-2026-0001", T0 + 2 * HOUR, false));
    c.report_ticket(report("CVE-2026-0002", T0 + 2 * HOUR, false));
    // r2 activates the first one; the second dies when its deadline enters the window
    at("r2.testnet", T0, 0);
    assert!(c.report_ticket(report("CVE-2026-0001", T0 + 2 * HOUR, false)).activated);
    at("r1.testnet", T0 + HOUR + 1, 0);
    assert_eq!(c.report_ticket(report("CVE-2026-0003", T0 + 5 * HOUR, false)).confirmations, 1);
    assert_eq!(c.report_ticket(report("CVE-2026-0004", T0 + 5 * HOUR, false)).confirmations, 1);
}

#[test]
#[should_panic(expected = "window too long")]
fn deadline_beyond_200_days_is_refused() {
    let mut c = setup();
    at("r1.testnet", T0, 0);
    c.report_ticket(report("CVE-2026-1111", T0 + MAX_WINDOW_MS + 1, false));
}

#[test]
#[should_panic(expected = "window too long")]
fn far_future_deadline_is_refused() {
    let mut c = setup();
    at("r1.testnet", T0, 0);
    c.report_ticket(report("CVE-2026-1111", u64::MAX, false));
}

#[test]
fn deadline_at_200_days_is_accepted() {
    assert_eq!(MAX_WINDOW_MS, 200 * 86_400_000);
    let mut c = setup_with(1, 8);
    at("r1.testnet", T0, 0);
    assert!(c.report_ticket(report("CVE-2026-1111", T0 + MAX_WINDOW_MS, false)).activated);
}

#[test]
#[should_panic(expected = "too many tickets today")]
fn activations_are_capped_per_utc_day() {
    let mut c = setup_with(1, 2);
    open(&mut c, "CVE-2026-0001", T0 + 2 * HOUR, false);
    open(&mut c, "CVE-2026-0002", T0 + 2 * HOUR, false);
    // both expired, so the open list has room, but the day's quota is spent
    open_at(&mut c, T0 + 3 * HOUR, "CVE-2026-0003", T0 + 5 * HOUR, false);
}

#[test]
fn daily_cap_resets_at_utc_midnight() {
    let mut c = setup_with(1, 2);
    assert_eq!(T0 % DAY, 8 * HOUR, "T0 is 08:00 UTC");
    open(&mut c, "CVE-2026-0001", T0 + 2 * HOUR, false);
    open(&mut c, "CVE-2026-0002", T0 + 2 * HOUR, false);
    let midnight = T0 + 16 * HOUR;
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        open_at(&mut c, midnight - 1, "CVE-2026-0003", midnight + 2 * HOUR, false)
    }));
    assert!(r.is_err(), "still the same day");
    assert_eq!(open_at(&mut c, midnight, "CVE-2026-0004", midnight + 2 * HOUR, false), 2);
    assert_eq!(open_at(&mut c, midnight, "CVE-2026-0005", midnight + 2 * HOUR, false), 3);
    assert_eq!((c.day_index, c.opened_today), (midnight / DAY, 2));
}

// ---------- close_ticket ----------

#[test]
#[should_panic(expected = "register first: storage_deposit")]
fn close_requires_registration() {
    let mut c = setup();
    open(&mut c, "CVE-2026-1111", T0 + 2 * HOUR, false);
    close(&mut c, "alice.testnet", 0, Status::Fixed, T0);
}

#[test]
#[should_panic(expected = "no such ticket")]
fn close_unknown_ticket() {
    let mut c = setup();
    pager(&mut c, "alice.testnet");
    close(&mut c, "alice.testnet", 7, Status::Fixed, T0);
}

#[test]
#[should_panic(expected = "deadline passed")]
fn close_at_the_deadline_is_refused() {
    let mut c = setup();
    let deadline = T0 + 2 * HOUR;
    open(&mut c, "CVE-2026-1111", deadline, false);
    pager(&mut c, "alice.testnet");
    close(&mut c, "alice.testnet", 0, Status::Fixed, deadline);
}

#[test]
#[should_panic(expected = "deadline passed")]
fn close_after_poke_is_refused() {
    let mut c = setup();
    open(&mut c, "CVE-2026-1111", T0 + 2 * HOUR, false);
    pager(&mut c, "alice.testnet");
    at("bob.testnet", T0 + 3 * HOUR, 0);
    assert_eq!(c.poke(), 1);
    close(&mut c, "alice.testnet", 0, Status::Fixed, T0 + 3 * HOUR);
}

#[test]
fn first_statement_counts_and_later_ones_replace_the_status() {
    let mut c = setup();
    let deadline = T0 + 2 * HOUR;
    open(&mut c, "CVE-2026-1111", deadline, false);
    pager(&mut c, "alice.testnet");
    let s = close(&mut c, "alice.testnet", 0, Status::NotAffected, T0 + 10);
    assert_eq!(s, Statement { status: Status::NotAffected, at_ms: U64(T0 + 10) });
    assert_eq!(
        events("kevin", "statement"),
        vec![json!({
            "account_id": "alice.testnet", "ticket_id": 0, "cve_id": "CVE-2026-1111", "status": "not_affected", "at_ms": (T0 + 10).to_string()
        })]
    );
    let t = c.get_ticket(0).unwrap();
    assert_eq!((t.closes, t.not_affected, t.fixed, t.mitigated), (1, 1, 0, 0));
    let d = c.get_desk(acct("alice.testnet"));
    assert_eq!((d.on_time, d.streak, d.best_streak), (1, 1, 1));

    let s = close(&mut c, "alice.testnet", 0, Status::Mitigated, deadline - 1);
    assert_eq!(s.at_ms.0, deadline - 1);
    let t = c.get_ticket(0).unwrap();
    assert_eq!((t.closes, t.not_affected, t.fixed, t.mitigated), (1, 0, 0, 1));
    let d = c.get_desk(acct("alice.testnet"));
    assert_eq!((d.on_time, d.streak, d.best_streak), (1, 1, 1), "a replacement is not a second answer");
    assert_eq!(c.get_statement(acct("alice.testnet"), 0), Some(s));
    assert_eq!(c.get_stats().statements_total, 1);
    // the same status again only moves at_ms
    close(&mut c, "alice.testnet", 0, Status::Mitigated, deadline - 1);
    let t = c.get_ticket(0).unwrap();
    assert_eq!((t.closes, t.mitigated), (1, 1));
}

#[test]
fn streak_counts_answers_and_a_settled_miss_resets_it() {
    let mut c = setup_with(1, 8);
    for i in 0..3 {
        open(&mut c, &format!("CVE-2026-000{i}"), T0 + (2 + i as u64) * HOUR, false);
    }
    pager(&mut c, "alice.testnet");
    close(&mut c, "alice.testnet", 0, Status::Fixed, T0);
    close(&mut c, "alice.testnet", 1, Status::Fixed, T0);
    let d = c.get_desk(acct("alice.testnet"));
    assert_eq!((d.on_time, d.streak, d.best_streak), (2, 2, 2));
    // ticket 2 is missed: the projected desk shows the reset before anyone settles
    let d = c.get_desk_at(T0 + 5 * HOUR, "alice.testnet");
    assert_eq!((d.on_time, d.missed, d.streak, d.best_streak), (2, 1, 0, 2));
    at("bob.testnet", T0 + 5 * HOUR, 0);
    c.settle(acct("alice.testnet"), None);
    let d = c.get_desk(acct("alice.testnet"));
    assert_eq!((d.on_time, d.missed, d.streak, d.best_streak, d.unsettled), (2, 1, 0, 2, 0));
}

#[test]
fn close_settles_the_caller_first() {
    let mut c = setup_with(1, 8);
    open(&mut c, "CVE-2026-0001", T0 + 2 * HOUR, false);
    open(&mut c, "CVE-2026-0002", T0 + 3 * HOUR, false);
    open(&mut c, "CVE-2026-0003", T0 + 5 * HOUR, false);
    pager(&mut c, "alice.testnet");
    close(&mut c, "alice.testnet", 0, Status::Fixed, T0);
    // ticket 1 is missed; answering ticket 2 settles it first, so the streak restarts at 1
    close(&mut c, "alice.testnet", 2, Status::Fixed, T0 + 4 * HOUR);
    let d = c.get_desk_at(T0 + 4 * HOUR, "alice.testnet");
    assert_eq!((d.on_time, d.missed, d.streak, d.best_streak, d.unsettled), (2, 1, 1, 1, 0));
    assert_eq!((d.committed.0, d.stored_committed.0, d.balance.0), (BAG - BAG / 100, BAG - BAG / 100, 0));
    assert_eq!(c.ft_total_supply().0, SUPPLY - BAG / 100);
}

#[test]
#[should_panic(expected = "go on call first: go_on_call")]
fn close_requires_being_on_call() {
    let mut c = setup();
    open(&mut c, "CVE-2026-1111", T0 + 2 * HOUR, false);
    holder(&mut c, "alice.testnet");
    close(&mut c, "alice.testnet", 0, Status::Fixed, T0);
}

#[test]
#[should_panic(expected = "go on call first: go_on_call")]
fn close_after_clocking_out_is_refused() {
    let mut c = setup();
    holder(&mut c, "alice.testnet");
    on_call(&mut c, "alice.testnet", MIN, T0);
    at("alice.testnet", T0, 1);
    c.clock_out();
    open(&mut c, "CVE-2026-1111", T0 + 2 * HOUR, false);
    close(&mut c, "alice.testnet", 0, Status::Fixed, T0);
}

impl Contract {
    fn get_desk_at(&self, t: u64, who: &str) -> Desk {
        at("viewer.testnet", t, 0);
        self.get_desk(acct(who))
    }
}

// ---------- settlement ----------

#[test]
fn silent_desk_burns_one_percent_and_the_closer_keeps_everything() {
    let mut c = setup();
    let deadline = T0 + 2 * HOUR;
    open(&mut c, "CVE-2026-1111", deadline, false);
    pager(&mut c, "alice.testnet");
    pager(&mut c, "bob.testnet");
    close(&mut c, "alice.testnet", 0, Status::Fixed, T0 + 100);
    let supply = c.ft_total_supply().0;

    // before anyone pokes, views already report the expiry and the burn
    at("viewer.testnet", deadline, 0);
    assert_eq!(c.get_ticket(0).unwrap().state, TicketState::Expired);
    assert!(c.get_open_tickets().is_empty());
    assert_eq!(bal(&c, "bob.testnet"), BAG - BAG / 100);
    assert_eq!(bal(&c, "alice.testnet"), BAG);
    let d = c.get_desk(acct("bob.testnet"));
    assert_eq!(
        (d.committed.0, d.stored_committed.0, d.pending_burn.0, d.unsettled, d.missed, d.burned.0),
        (BAG - BAG / 100, BAG, BAG / 100, 1, 1, BAG / 100)
    );
    assert_eq!(c.ft_total_supply().0, supply, "supply falls only as burns are settled");
    let s = c.get_stats();
    assert_eq!((s.tickets_open, s.tickets_expired, s.tickets_opened), (0, 1, 1));

    at("janitor.testnet", deadline, 0);
    let r = c.settle(acct("bob.testnet"), None);
    assert_eq!(r, SettleResult { settled: 1, remaining: 0, burned: U128(BAG / 100) });
    let burn = (BAG / 100).to_string();
    assert_eq!(
        events("nep141", "ft_burn"),
        vec![json!({ "owner_id": "bob.testnet", "amount": burn, "memo": "missed CVE-2026-1111" })]
    );
    assert_eq!(events("kevin", "ticket_expired"), vec![json!({ "ticket_id": 0, "cve_id": "CVE-2026-1111" })]);
    assert_eq!(
        events("kevin", "missed"),
        vec![json!({ "account_id": "bob.testnet", "ticket_id": 0, "cve_id": "CVE-2026-1111", "burned": burn })]
    );
    assert_eq!(c.ft_total_supply().0, supply - BAG / 100);
    assert_eq!(c.get_stats().burned_total.0, BAG / 100);
    let r = c.settle(acct("alice.testnet"), None);
    assert_eq!(r, SettleResult { settled: 1, remaining: 0, burned: U128(0) });
    assert_eq!(bal(&c, "alice.testnet"), BAG);
    let t = c.get_ticket(0).unwrap();
    assert_eq!((t.missed, t.burned.0, t.closes), (1, BAG / 100, 1));
    let d = c.get_desk(acct("bob.testnet"));
    assert_eq!(
        (d.committed.0, d.stored_committed.0, d.pending_burn.0, d.unsettled, d.missed, d.burned.0),
        (BAG - BAG / 100, BAG - BAG / 100, 0, 0, 1, BAG / 100)
    );
    // settling twice does nothing
    assert_eq!(c.settle(acct("bob.testnet"), None), SettleResult { settled: 0, remaining: 0, burned: U128(0) });
    assert_eq!(c.ft_total_supply().0, supply - BAG / 100);
    let s = c.get_stats();
    assert_eq!((s.on_call, s.committed_total.0, s.misses_total), (2, 2 * BAG - BAG / 100, 1));
}

#[test]
fn ransomware_ticket_burns_five_percent() {
    let mut c = setup();
    open(&mut c, "CVE-2026-6666", T0 + 2 * HOUR, true);
    pager(&mut c, "bob.testnet");
    at("janitor.testnet", T0 + 2 * HOUR, 0);
    assert_eq!(c.settle(acct("bob.testnet"), None).burned.0, BAG * 5 / 100);
    assert_eq!(bal(&c, "bob.testnet"), BAG * 95 / 100);
}

#[test]
fn burns_compound_in_expiry_order_with_floor_math() {
    let mut c = setup();
    // opened in one order, expiring in the other: settlement follows expiry, not id
    open(&mut c, "CVE-2026-0001", T0 + 3 * HOUR, true);
    open(&mut c, "CVE-2026-0002", T0 + 2 * HOUR, false);
    register(&mut c, "bob.testnet");
    at(ME, T0, 0); // nobody can do this on chain; it only gives bob an odd committed amount
    let odd = 9_999 * KEV + 7;
    c.pool -= odd;
    c.committed_total += odd;
    let d = c.desks.get_mut(&acct("bob.testnet")).unwrap();
    (d.committed, d.on_call) = (odd, true);
    let after_first = odd - odd / 100;
    let expected = after_first - after_first * 5 / 100;
    assert_eq!(miss_burn(odd, 100), odd / 100);
    at("viewer.testnet", T0 + 3 * HOUR, 0);
    assert_eq!(bal(&c, "bob.testnet"), expected, "projection compounds the same way");
    c.poke();
    assert_eq!(c.expired.get(0), Some(&1));
    assert_eq!(c.expired.get(1), Some(&0));
    let r = c.settle(acct("bob.testnet"), None);
    assert_eq!(r.burned.0, odd - expected);
    assert_eq!(c.desks.get(&acct("bob.testnet")).unwrap().committed, expected);
    assert_eq!(c.committed_total, expected);
    assert_eq!(c.get_ticket(1).unwrap().burned.0, odd / 100);
    assert_eq!(c.get_ticket(0).unwrap().burned.0, after_first * 5 / 100);
}

#[test]
fn simultaneous_expiries_are_ordered_by_id() {
    let mut c = setup();
    open(&mut c, "CVE-2026-0001", T0 + 2 * HOUR, false);
    open(&mut c, "CVE-2026-0002", T0 + 2 * HOUR, false);
    at("x.testnet", T0 + 2 * HOUR, 0);
    assert_eq!(c.poke(), 2);
    assert_eq!((c.expired.get(0), c.expired.get(1)), (Some(&0), Some(&1)));
    assert_eq!(event_lines("ticket_expired").len(), 1, "one log line for the batch");
    assert_eq!(c.poke(), 0);
}

#[test]
fn desk_pool_is_never_settled() {
    let mut c = setup();
    open(&mut c, "CVE-2026-1111", T0 + 2 * HOUR, false);
    at("janitor.testnet", T0 + 2 * HOUR, 0);
    assert_eq!(c.settle(acct(ME), Some(200)), SettleResult { settled: 0, remaining: 0, burned: U128(0) });
    assert_eq!(bal(&c, ME), SUPPLY);
    assert_eq!(c.ft_total_supply().0, SUPPLY);
}

#[test]
fn settle_of_an_unknown_account_is_a_no_op() {
    let mut c = setup();
    open(&mut c, "CVE-2026-1111", T0 + 2 * HOUR, false);
    at("janitor.testnet", T0 + 2 * HOUR, 0);
    assert_eq!(c.settle(acct("nobody.testnet"), None), SettleResult { settled: 0, remaining: 0, burned: U128(0) });
}

#[test]
fn zero_burn_miss_counts_without_a_burn_event() {
    let mut c = new_contract(2, 8, 1, 0);
    open(&mut c, "CVE-2026-1111", T0 + 2 * HOUR, false);
    holder(&mut c, "carol.testnet");
    on_call(&mut c, "carol.testnet", 99, T0); // 1% of 99 floors to 0
    at("janitor.testnet", T0 + 2 * HOUR, 0);
    assert_eq!(c.settle(acct("carol.testnet"), None).settled, 1);
    assert!(event_lines("ft_burn").is_empty());
    assert_eq!(event_lines("missed").len(), 1);
    assert_eq!(c.get_desk(acct("carol.testnet")).missed, 1);
}

#[test]
fn going_on_call_after_expiry_is_not_liable() {
    let mut c = setup();
    open(&mut c, "CVE-2026-1111", T0 + 2 * HOUR, false);
    holder(&mut c, "late.testnet");
    // past the deadline but nobody poked: go_on_call itself runs expiry first
    let d = on_call(&mut c, "late.testnet", BAG, T0 + 2 * HOUR);
    assert_eq!((d.unsettled, d.missed, d.first_on_call_ms.0), (0, 0, T0 + 2 * HOUR));
    assert_eq!(c.desks.get(&acct("late.testnet")).unwrap().cursor, 1, "the cursor starts at the end");
    at("janitor.testnet", T0 + 3 * HOUR, 0);
    assert_eq!(c.settle(acct("late.testnet"), None).settled, 0);
    assert_eq!(bal(&c, "late.testnet"), BAG);
}

#[test]
fn a_desk_off_call_is_never_settled() {
    let mut c = setup();
    open(&mut c, "CVE-2026-1111", T0 + 2 * HOUR, false);
    holder(&mut c, "alice.testnet");
    at("janitor.testnet", T0 + 3 * HOUR, 0);
    assert_eq!(c.settle(acct("alice.testnet"), None), SettleResult { settled: 0, remaining: 0, burned: U128(0) });
    assert!(event_lines("missed").is_empty());
    let d = c.get_desk(acct("alice.testnet"));
    assert_eq!((d.balance.0, d.unsettled, d.missed, d.pending_burn.0, d.on_call), (BAG, 0, 0, 0, false));
    assert_eq!(c.ft_total_supply().0, SUPPLY);
}

/// Opens `n` tickets with quorum 1 that all expire at T0 + 2h.
fn many(n: u32) -> Contract {
    let mut c = setup_with(1, 128);
    for i in 0..n {
        open(&mut c, &format!("CVE-2026-{:04}", i + 1), T0 + 2 * HOUR, false);
    }
    c
}

#[test]
fn settle_limit_defaults_to_50() {
    let mut c = many(128);
    pager(&mut c, "bob.testnet");
    at("janitor.testnet", T0 + 2 * HOUR, 0);
    assert_eq!(c.get_desk(acct("bob.testnet")).unsettled, 128);
    assert_eq!(c.poke(), 128);
    at("janitor.testnet", T0 + 2 * HOUR, 0);
    let r = c.settle(acct("bob.testnet"), None);
    assert_eq!((r.settled, r.remaining), (50, 78));
    at("janitor.testnet", T0 + 2 * HOUR, 0);
    let r = c.settle(acct("bob.testnet"), Some(3));
    assert_eq!((r.settled, r.remaining), (3, 75));
    let r = c.settle(acct("bob.testnet"), Some(0));
    assert_eq!((r.settled, r.remaining), (0, 75));
    while c.get_desk(acct("bob.testnet")).unsettled > 0 {
        at("janitor.testnet", T0 + 2 * HOUR, 0);
        c.settle(acct("bob.testnet"), Some(200));
    }
    let mut expected = BAG;
    for _ in 0..128 {
        expected -= expected / 100;
    }
    assert_eq!(bal(&c, "bob.testnet"), expected);
    assert_eq!(c.ft_total_supply().0, SUPPLY - (BAG - expected));
    assert_eq!(c.get_desk(acct("bob.testnet")).missed, 128);
}

#[test]
fn settle_limit_caps_at_200() {
    // 228 expired tickets over two UTC days, all answered, so no logs limit how far one call
    // gets. The statements are written directly: answering through close_ticket would settle
    // alice as she goes.
    let mut c = setup_with(1, 128);
    pager(&mut c, "alice.testnet");
    let idx = c.desks.get(&acct("alice.testnet")).unwrap().idx;
    for wave in 0..2u64 {
        let start = T0 + wave * DAY;
        let n = if wave == 0 { 128 } else { 100 };
        for i in 0..n {
            let id = open_at(&mut c, start, &format!("CVE-2026-{}{:04}", wave + 1, i), start + 2 * HOUR, false);
            c.statements.insert((idx, id), Statement { status: Status::Fixed, at_ms: U64(start) });
        }
    }
    at("janitor.testnet", T0 + 2 * DAY, 0);
    c.poke();
    at("janitor.testnet", T0 + 2 * DAY, 0);
    let r = c.settle(acct("alice.testnet"), Some(u32::MAX));
    assert_eq!((r.settled, r.remaining, r.burned.0), (200, 28, 0));
}

#[test]
fn settle_stops_before_the_receipt_log_limit() {
    let mut c = many(128);
    let long = format!("{}.testnet", "a".repeat(56));
    assert_eq!(long.len(), 64);
    pager(&mut c, &long);
    at("janitor.testnet", T0 + 2 * HOUR, 0);
    let r = c.settle(acct(&long), Some(200));
    assert!(r.settled > 10 && r.settled < 128, "settled {}", r.settled);
    assert_eq!(r.remaining, 128 - r.settled);
    let logs = get_logs();
    let bytes: usize = logs.iter().map(|l| l.len()).sum();
    assert!(bytes <= 16_384 - 1_024, "{bytes} log bytes");
    assert!(logs.len() <= 3);
}

// ---------- transfers move the free balance only ----------

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn ft_transfer_needs_one_yocto() {
    let mut c = setup();
    holder(&mut c, "alice.testnet");
    register(&mut c, "bob.testnet");
    at("alice.testnet", T0, 0);
    c.ft_transfer(acct("bob.testnet"), U128(1), None);
}

#[test]
#[should_panic(expected = "The account carol.testnet is not registered")]
fn ft_transfer_to_unregistered_account() {
    let mut c = setup();
    holder(&mut c, "alice.testnet");
    transfer(&mut c, "alice.testnet", "carol.testnet", 1, T0);
}

#[test]
#[should_panic(expected = "The account doesn't have enough balance")]
fn ft_transfer_more_than_the_balance() {
    let mut c = setup();
    holder(&mut c, "alice.testnet");
    register(&mut c, "bob.testnet");
    transfer(&mut c, "alice.testnet", "bob.testnet", BAG + 1, T0);
}

/// Alice holds 6,000 free and 4,000 committed.
fn split_desk() -> Contract {
    let mut c = setup();
    open(&mut c, "CVE-2026-1111", T0 + 2 * HOUR, false);
    holder(&mut c, "alice.testnet");
    register(&mut c, "bob.testnet");
    on_call(&mut c, "alice.testnet", 4_000 * KEV, T0);
    c
}

#[test]
#[should_panic(expected = "not enough free balance: committed tokens cannot move")]
fn ft_transfer_of_committed_tokens_is_refused() {
    let mut c = split_desk();
    transfer(&mut c, "alice.testnet", "bob.testnet", 6_000 * KEV + 1, T0);
}

#[test]
#[should_panic(expected = "not enough free balance: committed tokens cannot move")]
fn ft_transfer_of_the_whole_bag_is_refused() {
    let mut c = split_desk();
    transfer(&mut c, "alice.testnet", "bob.testnet", BAG, T0);
}

#[test]
#[should_panic(expected = "The account doesn't have enough balance")]
fn ft_transfer_above_free_plus_committed_keeps_the_standard_text() {
    let mut c = split_desk();
    transfer(&mut c, "alice.testnet", "bob.testnet", BAG + 1, T0);
}

#[test]
#[should_panic(expected = "not enough free balance: committed tokens cannot move")]
fn ft_transfer_call_of_committed_tokens_is_refused() {
    let mut c = split_desk();
    at("alice.testnet", T0, 1);
    let _ = c.ft_transfer_call(acct("bob.testnet"), U128(6_000 * KEV + 1), None, "".into());
}

#[test]
fn transfers_move_the_free_balance_and_settle_nobody() {
    let mut c = split_desk();
    // alice is behind (the ticket expired unanswered); the free balance still moves
    transfer(&mut c, "alice.testnet", "bob.testnet", 6_000 * KEV, T0 + 3 * HOUR);
    assert!(event_lines("ft_burn").is_empty() && event_lines("missed").is_empty());
    assert_eq!(bal(&c, "bob.testnet"), 6_000 * KEV);
    let d = c.get_desk(acct("alice.testnet"));
    assert_eq!((d.balance.0, d.stored_committed.0, d.unsettled), (0, 4_000 * KEV, 1));
    assert_eq!(bal(&c, "alice.testnet"), 4_000 * KEV - 40 * KEV);
    assert_eq!(c.ft_total_supply().0, SUPPLY);
    // and back again into a desk that is behind
    transfer(&mut c, "bob.testnet", "alice.testnet", KEV, T0 + 3 * HOUR);
    assert_eq!(c.get_desk(acct("alice.testnet")).balance.0, KEV);
    assert_eq!(c.get_desk(acct("alice.testnet")).unsettled, 1);
}

#[test]
fn balance_of_is_free_plus_effective_committed_and_free_tokens_never_burn() {
    let mut c = split_desk();
    assert_eq!(bal(&c, "alice.testnet"), BAG);
    at("viewer.testnet", T0 + 2 * HOUR, 0);
    assert_eq!(bal(&c, "alice.testnet"), 6_000 * KEV + 4_000 * KEV - 40 * KEV);
    at("janitor.testnet", T0 + 2 * HOUR, 0);
    assert_eq!(c.settle(acct("alice.testnet"), None).burned.0, 40 * KEV, "1% of the 4,000 committed");
    let d = c.get_desk(acct("alice.testnet"));
    assert_eq!((d.balance.0, d.committed.0, d.stored_committed.0), (6_000 * KEV, 3_960 * KEV, 3_960 * KEV));
    let sum = bal(&c, "alice.testnet") + bal(&c, "bob.testnet") + bal(&c, ME);
    assert_eq!(sum, c.ft_total_supply().0, "settled balances add up to the supply");
}

// ---------- claim_starter ----------

#[test]
#[should_panic(expected = "register first: storage_deposit")]
fn claim_requires_registration() {
    let mut c = setup();
    at("alice.testnet", T0, 0);
    c.claim_starter();
}

#[test]
#[should_panic(expected = "starter already claimed")]
fn claim_is_once_per_account() {
    let mut c = setup();
    holder(&mut c, "alice.testnet");
    at("alice.testnet", T0, 0);
    c.claim_starter();
}

#[test]
#[should_panic(expected = "desk pool is empty")]
fn claim_from_an_empty_pool() {
    at(ME, T0, 0);
    let mut c =
        Contract::new(reporters(), 2, 100, 500, U64(HOUR), 8, U128(BAG), U128(BAG + BAG / 2), U128(MIN), U64(0));
    holder(&mut c, "alice.testnet");
    register(&mut c, "bob.testnet");
    at("bob.testnet", T0, 0);
    c.claim_starter();
}

#[test]
fn claim_moves_the_bag_from_the_pool() {
    let mut c = setup();
    holder(&mut c, "alice.testnet");
    assert_eq!(bal(&c, ME), SUPPLY - BAG);
    assert_eq!(c.get_stats().desk_pool.0, SUPPLY - BAG);
    assert_eq!(c.ft_total_supply().0, SUPPLY);
    assert_eq!(
        events("nep141", "ft_transfer"),
        vec![
            json!({ "old_owner_id": ME, "new_owner_id": "alice.testnet", "amount": BAG.to_string(), "memo": "starter bag" })
        ]
    );
    assert!(c.get_desk(acct("alice.testnet")).claimed_starter);
}

#[test]
fn claim_credits_the_free_balance_without_settling() {
    let mut c = many(51);
    holder(&mut c, "bob.testnet");
    register(&mut c, "alice.testnet");
    transfer(&mut c, "bob.testnet", "alice.testnet", MIN, T0);
    on_call(&mut c, "alice.testnet", MIN, T0);
    at("alice.testnet", T0 + 2 * HOUR, 0);
    assert_eq!(c.claim_starter().0, BAG);
    assert!(event_lines("ft_burn").is_empty());
    let d = c.get_desk(acct("alice.testnet"));
    assert_eq!((d.balance.0, d.stored_committed.0, d.unsettled), (BAG, MIN, 51));
}

#[test]
fn tokens_sent_to_the_pool_stay_there() {
    let mut c = setup();
    holder(&mut c, "alice.testnet");
    transfer(&mut c, "alice.testnet", ME, BAG, T0);
    assert_eq!(bal(&c, ME), SUPPLY);
    assert_eq!(bal(&c, "alice.testnet"), 0);
}

// ---------- storage ----------

#[test]
fn storage_bounds_and_balance() {
    let mut c = setup();
    let b = c.storage_balance_bounds();
    assert_eq!(Some(b.min), b.max);
    assert_eq!(b.min.as_yoctonear(), c.registration_bytes as u128 * 10u128.pow(19));
    assert!(c.storage_balance_of(acct("alice.testnet")).is_none());
    register(&mut c, "alice.testnet");
    let s = c.storage_balance_of(acct("alice.testnet")).unwrap();
    assert_eq!((s.total, s.available.as_yoctonear()), (b.min, 0));
    assert_eq!(c.get_stats().accounts, 1);
    assert!(c.storage_balance_of(acct(ME)).is_some());
}

#[test]
#[should_panic(expected = "The attached deposit is less than the minimum storage balance")]
fn storage_deposit_below_minimum() {
    let mut c = setup();
    let d = min_deposit(&c);
    at("alice.testnet", T0, d - 1);
    c.storage_deposit(None, None);
}

#[test]
fn storage_deposit_for_another_account_and_twice() {
    let mut c = setup();
    let d = min_deposit(&c);
    at("alice.testnet", T0, d + 5);
    c.storage_deposit(Some(acct("bob.testnet")), Some(true));
    assert!(c.get_desk(acct("bob.testnet")).registered);
    assert!(!c.get_desk(acct("alice.testnet")).registered);
    at("alice.testnet", T0, d);
    c.storage_deposit(Some(acct("bob.testnet")), None);
    assert_eq!(c.get_stats().accounts, 1);
}

#[test]
#[should_panic(expected = "The amount is greater than the available storage balance")]
fn storage_withdraw_has_nothing_to_give() {
    let mut c = setup();
    register(&mut c, "alice.testnet");
    at("alice.testnet", T0, 1);
    assert_eq!(c.storage_withdraw(None).available.as_yoctonear(), 0);
    c.storage_withdraw(Some(NearToken::from_yoctonear(1)));
}

#[test]
#[should_panic(expected = "desks are permanent")]
fn unregister_is_refused_with_tokens() {
    let mut c = setup();
    holder(&mut c, "alice.testnet");
    at("alice.testnet", T0, 1);
    c.storage_unregister(Some(true));
}

#[test]
#[should_panic(expected = "desks are permanent")]
fn unregister_is_refused_even_when_empty() {
    let mut c = setup();
    register(&mut c, "alice.testnet");
    at("alice.testnet", T0, 1);
    c.storage_unregister(None);
}

#[test]
fn unregister_of_an_unknown_account_returns_false() {
    let mut c = setup();
    at("alice.testnet", T0, 1);
    assert!(!c.storage_unregister(None));
    assert_eq!(get_logs(), vec!["The account alice.testnet is not registered".to_string()]);
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn unregister_needs_one_yocto() {
    let mut c = setup();
    register(&mut c, "alice.testnet");
    at("alice.testnet", T0, 0);
    c.storage_unregister(None);
}

// ---------- ft_transfer_call / ft_resolve_transfer ----------

fn after_transfer_call() -> Contract {
    let mut c = setup();
    holder(&mut c, "alice.testnet");
    register(&mut c, "dex.testnet");
    at("alice.testnet", T0, 1);
    let _ = c.ft_transfer_call(acct("dex.testnet"), U128(1000), None, "msg".into());
    assert_eq!(bal(&c, "dex.testnet"), 1000);
    c
}

#[test]
fn resolve_refunds_the_unused_amount() {
    let mut c = after_transfer_call();
    with_result(ME, T0, PromiseResult::Successful(b"\"400\"".to_vec()));
    let used = c.ft_resolve_transfer(acct("alice.testnet"), acct("dex.testnet"), U128(1000));
    assert_eq!(used.0, 600);
    assert_eq!(bal(&c, "alice.testnet"), BAG - 600);
    assert_eq!(bal(&c, "dex.testnet"), 600);
    assert_eq!(
        events("nep141", "ft_transfer"),
        vec![
            json!({ "old_owner_id": "dex.testnet", "new_owner_id": "alice.testnet", "amount": "400", "memo": "refund" })
        ]
    );
}

#[test]
fn resolve_refunds_everything_when_the_receiver_fails() {
    let mut c = after_transfer_call();
    with_result(ME, T0, PromiseResult::Failed);
    assert_eq!(c.ft_resolve_transfer(acct("alice.testnet"), acct("dex.testnet"), U128(1000)).0, 0);
    assert_eq!(bal(&c, "alice.testnet"), BAG);
    assert_eq!(bal(&c, "dex.testnet"), 0);
}

#[test]
fn resolve_caps_a_refund_claim_above_the_amount() {
    let mut c = after_transfer_call();
    with_result(ME, T0, PromiseResult::Successful(b"\"340282366920938463463374607431768211455\"".to_vec()));
    assert_eq!(c.ft_resolve_transfer(acct("alice.testnet"), acct("dex.testnet"), U128(1000)).0, 0);
    assert_eq!(bal(&c, "alice.testnet"), BAG);
}

#[test]
fn resolve_settles_nobody_and_refunds_from_the_free_balance() {
    let mut c = setup();
    open(&mut c, "CVE-2026-1111", T0 + 2 * HOUR, false);
    holder(&mut c, "alice.testnet");
    on_call(&mut c, "alice.testnet", 4_000 * KEV, T0);
    holder(&mut c, "dex.testnet");
    on_call(&mut c, "dex.testnet", MIN, T0);
    at("alice.testnet", T0, 1);
    let _ = c.ft_transfer_call(acct("dex.testnet"), U128(1000), None, "msg".into());
    // dex moves most of what it got before the callback, and the ticket expires meanwhile
    transfer(&mut c, "dex.testnet", "alice.testnet", 9_000 * KEV + 700, T0 + 1);
    with_result(ME, T0 + 2 * HOUR, PromiseResult::Failed);
    assert_eq!(c.ft_resolve_transfer(acct("alice.testnet"), acct("dex.testnet"), U128(1000)).0, 700);
    assert!(events("nep141", "ft_burn").is_empty(), "nobody was settled");
    assert_eq!(
        events("nep141", "ft_transfer"),
        vec![
            json!({ "old_owner_id": "dex.testnet", "new_owner_id": "alice.testnet", "amount": "300", "memo": "refund" })
        ]
    );
    assert_eq!(c.get_desk(acct("dex.testnet")).balance.0, 0);
    assert_eq!(c.get_desk(acct("dex.testnet")).stored_committed.0, MIN, "committed tokens are never refunded");
    assert_eq!(c.get_desk(acct("alice.testnet")).balance.0, 6_000 * KEV - 1000 + 9_000 * KEV + 700 + 300);
    assert_eq!(c.get_desk(acct("alice.testnet")).unsettled, 1);
}

#[test]
fn transfer_call_into_the_pool_is_refunded() {
    let mut c = setup();
    holder(&mut c, "alice.testnet");
    at("alice.testnet", T0, 1);
    let _ = c.ft_transfer_call(acct(ME), U128(1000), None, "".into());
    with_result(ME, T0, PromiseResult::Failed);
    assert_eq!(c.ft_resolve_transfer(acct("alice.testnet"), acct(ME), U128(1000)).0, 0);
    assert_eq!(bal(&c, "alice.testnet"), BAG);
    assert_eq!(bal(&c, ME), SUPPLY - BAG);
}

#[test]
fn plain_transfer_into_the_pool_is_still_allowed() {
    let mut c = setup();
    holder(&mut c, "alice.testnet");
    transfer(&mut c, "alice.testnet", ME, 1000, T0);
    assert_eq!(bal(&c, ME), SUPPLY - BAG + 1000);
}

#[test]
fn transfer_call_works_right_before_a_deadline() {
    let mut c = setup();
    let deadline = T0 + 2 * HOUR;
    open(&mut c, "CVE-2026-1111", deadline, false);
    holder(&mut c, "alice.testnet");
    on_call(&mut c, "alice.testnet", MIN, T0);
    register(&mut c, "dex.testnet");
    at("alice.testnet", deadline - 1, 1);
    let _ = c.ft_transfer_call(acct("dex.testnet"), U128(1000), None, "".into());
    assert_eq!(bal(&c, "dex.testnet"), 1000);
}

// ---------- views ----------

#[test]
fn ticket_listing_views() {
    let mut c = setup_with(1, 128);
    for i in 0..105u64 {
        open(&mut c, &format!("CVE-2026-{:04}", i + 1), T0 + (200 - i) * HOUR, false);
    }
    at("viewer.testnet", T0, 0);
    let page = c.get_tickets(0, 1000);
    assert_eq!(page.len(), 100, "limit is capped at 100");
    assert_eq!(page.iter().map(|t| t.id).collect::<Vec<_>>(), (0..100).collect::<Vec<_>>());
    assert_eq!(c.get_tickets(100, 100).len(), 5);
    assert!(c.get_tickets(200, 10).is_empty());
    let open_now = c.get_open_tickets();
    assert_eq!(open_now.len(), 105);
    assert_eq!(open_now[0].id, 104, "deadline ascending");
    assert!(c.get_ticket(105).is_none());
    assert!(c.get_ticket_by_cve("CVE-2026-9999".into()).is_none());
    at("viewer.testnet", T0 + 100 * HOUR, 0);
    let s = c.get_stats();
    assert_eq!((s.tickets_opened, s.tickets_open, s.tickets_expired, s.now_ms.0), (105, 100, 5, T0 + 100 * HOUR));
}

#[test]
fn statement_views_and_unknown_desks() {
    let mut c = setup();
    open(&mut c, "CVE-2026-0001", T0 + 2 * HOUR, false);
    open(&mut c, "CVE-2026-0002", T0 + 2 * HOUR, false);
    pager(&mut c, "alice.testnet");
    let s = close(&mut c, "alice.testnet", 1, Status::Fixed, T0);
    assert_eq!(c.get_statements(acct("alice.testnet"), vec![0, 1, 9]), vec![None, Some(s), None]);
    assert_eq!(c.get_statements(acct("zed.testnet"), vec![0, 1]), vec![None, None]);
    assert_eq!(c.get_statement(acct("zed.testnet"), 1), None);
    assert_eq!(c.get_desk(acct("zed.testnet")), Desk::default());
    assert_eq!(bal(&c, "zed.testnet"), 0);
    let pool = c.get_desk(acct(ME));
    assert_eq!(pool, Desk { registered: true, balance: U128(SUPPLY - BAG), ..Desk::default() });
}

// ---------- go_on_call ----------

#[test]
fn going_on_call_commits_free_tokens_and_joins_the_roster() {
    let mut c = setup();
    open(&mut c, "CVE-2026-0001", T0 + 2 * HOUR, false);
    open_at(&mut c, T0 + HOUR, "CVE-2026-0002", T0 + 4 * HOUR, false);
    holder(&mut c, "alice.testnet");
    // ticket 0 expired before alice went on call; ticket 1 is open and counts
    let d = on_call(&mut c, "alice.testnet", MIN, T0 + 3 * HOUR);
    assert_eq!(
        events("kevin", "on_call"),
        vec![json!({ "account_id": "alice.testnet", "amount": MIN.to_string(), "committed": MIN.to_string() })]
    );
    assert_eq!(d, c.get_desk_at(T0 + 3 * HOUR, "alice.testnet"), "returns what get_desk returns");
    assert_eq!((d.on_call, d.balance.0, d.committed.0, d.stored_committed.0), (true, BAG - MIN, MIN, MIN));
    assert_eq!((d.first_on_call_ms.0, d.on_call_since_ms.0, d.unsettled), (T0 + 3 * HOUR, T0 + 3 * HOUR, 0));
    assert_eq!(d.shift_ends_ms.0, T0 + 3 * HOUR, "no minimum shift in this setup");
    assert_eq!(c.desks.get(&acct("alice.testnet")).unwrap().cursor, 1, "the cursor starts at the end");
    assert_eq!(bal(&c, "alice.testnet"), BAG);
    let s = c.get_stats();
    assert_eq!((s.on_call, s.committed_total.0, s.roster), (1, MIN, 1));
    let d = c.get_desk_at(T0 + 4 * HOUR, "alice.testnet");
    assert_eq!((d.unsettled, d.missed, d.pending_burn.0), (1, 1, MIN / 100), "liable for the ticket open at the time");
}

#[test]
#[should_panic(expected = "register first: storage_deposit")]
fn go_on_call_requires_registration() {
    let mut c = setup();
    on_call(&mut c, "alice.testnet", MIN, T0);
}

#[test]
#[should_panic(expected = "amount must be positive")]
fn go_on_call_rejects_zero() {
    let mut c = setup();
    holder(&mut c, "alice.testnet");
    on_call(&mut c, "alice.testnet", 0, T0);
}

#[test]
#[should_panic(expected = "commit at least the minimum to go on call")]
fn go_on_call_below_the_minimum() {
    let mut c = setup();
    holder(&mut c, "alice.testnet");
    on_call(&mut c, "alice.testnet", MIN - 1, T0);
}

#[test]
#[should_panic(expected = "not enough free balance")]
fn go_on_call_needs_the_free_balance() {
    let mut c = setup();
    register(&mut c, "alice.testnet");
    on_call(&mut c, "alice.testnet", MIN, T0);
}

#[test]
#[should_panic(expected = "not enough free balance")]
fn top_up_needs_the_free_balance() {
    let mut c = setup();
    holder(&mut c, "alice.testnet");
    on_call(&mut c, "alice.testnet", BAG - 1, T0);
    on_call(&mut c, "alice.testnet", 2, T0);
}

#[test]
fn top_up_of_any_size_and_the_roster_takes_a_desk_once() {
    let mut c = setup();
    holder(&mut c, "alice.testnet");
    on_call(&mut c, "alice.testnet", MIN, T0);
    let d = on_call(&mut c, "alice.testnet", 1, T0 + 5);
    assert_eq!(
        (d.committed.0, d.balance.0, d.first_on_call_ms.0, d.on_call_since_ms.0),
        (MIN + 1, BAG - MIN - 1, T0, T0)
    );
    assert_eq!(
        events("kevin", "on_call"),
        vec![json!({ "account_id": "alice.testnet", "amount": "1", "committed": (MIN + 1).to_string() })]
    );
    at("alice.testnet", T0 + 10, 1);
    c.clock_out();
    let d = on_call(&mut c, "alice.testnet", MIN, T0 + 20);
    assert_eq!((d.first_on_call_ms.0, d.on_call_since_ms.0), (T0, T0 + 20));
    let s = c.get_stats();
    assert_eq!((s.on_call, s.committed_total.0, s.roster), (1, MIN, 1));
}

#[test]
fn top_up_settles_first_at_the_old_committed_amount() {
    let mut c = setup();
    open(&mut c, "CVE-2026-1111", T0 + 2 * HOUR, false);
    holder(&mut c, "alice.testnet");
    on_call(&mut c, "alice.testnet", MIN, T0);
    let d = on_call(&mut c, "alice.testnet", 5 * MIN, T0 + 2 * HOUR);
    assert_eq!(
        events("nep141", "ft_burn"),
        vec![json!({ "owner_id": "alice.testnet", "amount": (MIN / 100).to_string(), "memo": "missed CVE-2026-1111" })]
    );
    assert_eq!((d.committed.0, d.unsettled, d.missed, d.burned.0), (MIN - MIN / 100 + 5 * MIN, 0, 1, MIN / 100));
    assert_eq!(c.get_stats().committed_total.0, MIN - MIN / 100 + 5 * MIN);
}

#[test]
#[should_panic(expected = "account behind: call settle first")]
fn top_up_while_more_than_50_behind_is_refused() {
    let mut c = many(51);
    holder(&mut c, "alice.testnet");
    on_call(&mut c, "alice.testnet", MIN, T0);
    on_call(&mut c, "alice.testnet", MIN, T0 + 2 * HOUR);
}

// ---------- clock_out ----------

#[test]
#[should_panic(expected = "not on call")]
fn clock_out_requires_being_on_call() {
    let mut c = setup();
    holder(&mut c, "alice.testnet");
    at("alice.testnet", T0, 1);
    c.clock_out();
}

#[test]
#[should_panic(expected = "not on call")]
fn clock_out_of_an_unknown_account() {
    let mut c = setup();
    at("alice.testnet", T0, 1);
    c.clock_out();
}

#[test]
#[should_panic(expected = "account behind: call settle first")]
fn clock_out_while_more_than_50_behind_is_refused() {
    let mut c = many(51);
    pager(&mut c, "alice.testnet");
    at("alice.testnet", T0 + 2 * HOUR, 1);
    c.clock_out();
}

#[test]
#[should_panic(expected = "answer every open ticket before you clock out")]
fn clock_out_with_an_unanswered_open_ticket_is_refused() {
    let mut c = setup();
    open(&mut c, "CVE-2026-0001", T0 + 2 * HOUR, false);
    open(&mut c, "CVE-2026-0002", T0 + 3 * HOUR, false);
    pager(&mut c, "alice.testnet");
    close(&mut c, "alice.testnet", 0, Status::Fixed, T0);
    at("alice.testnet", T0 + 2 * HOUR - 1, 1);
    c.clock_out();
}

#[test]
fn clean_clock_out_returns_the_tokens_and_keeps_the_record() {
    let mut c = setup();
    open(&mut c, "CVE-2026-0001", T0 + 2 * HOUR, false);
    holder(&mut c, "alice.testnet");
    on_call(&mut c, "alice.testnet", 4_000 * KEV, T0);
    close(&mut c, "alice.testnet", 0, Status::Fixed, T0 + 1);
    at("alice.testnet", T0 + 2, 1);
    let d = c.clock_out();
    assert_eq!(
        events("kevin", "clocked_out"),
        vec![json!({ "account_id": "alice.testnet", "returned": (4_000 * KEV).to_string() })]
    );
    assert_eq!((d.on_call, d.balance.0, d.committed.0, d.stored_committed.0), (false, BAG, 0, 0));
    assert_eq!((d.on_time, d.streak, d.month_on_time, d.first_on_call_ms.0), (1, 1, 1, T0));
    assert_eq!((d.on_call_since_ms.0, d.shift_ends_ms.0), (T0, 0));
    let s = c.get_stats();
    assert_eq!((s.on_call, s.committed_total.0, s.roster), (0, 0, 1));
    // a ticket opened after clocking out expires: nothing is pending and settle is a no-op
    open_at(&mut c, T0 + 3, "CVE-2026-0002", T0 + 3 * HOUR, false);
    at("janitor.testnet", T0 + 4 * HOUR, 0);
    assert_eq!(c.settle(acct("alice.testnet"), None), SettleResult { settled: 0, remaining: 0, burned: U128(0) });
    assert_eq!(bal(&c, "alice.testnet"), BAG);
    // rejoining is liable only for what expires afterwards
    let d = on_call(&mut c, "alice.testnet", 4_000 * KEV, T0 + 4 * HOUR);
    assert_eq!(d.unsettled, 0);
    open_at(&mut c, T0 + 4 * HOUR, "CVE-2026-0003", T0 + 6 * HOUR, false);
    at("janitor.testnet", T0 + 6 * HOUR, 0);
    assert_eq!(c.settle(acct("alice.testnet"), None).burned.0, 40 * KEV);
}

#[test]
fn clock_out_settles_a_due_miss_first() {
    let mut c = setup();
    open(&mut c, "CVE-2026-0001", T0 + 2 * HOUR, false);
    holder(&mut c, "alice.testnet");
    on_call(&mut c, "alice.testnet", MIN, T0);
    at("alice.testnet", T0 + 2 * HOUR, 1);
    let d = c.clock_out();
    assert_eq!(event_lines("ft_burn").len(), 1);
    assert_eq!(
        events("kevin", "clocked_out"),
        vec![json!({ "account_id": "alice.testnet", "returned": (MIN - MIN / 100).to_string() })]
    );
    assert_eq!((d.balance.0, d.missed, d.burned.0, d.on_call), (BAG - MIN / 100, 1, MIN / 100, false));
    assert_eq!(c.get_stats().misses_total, 1);
}

// ---------- the minimum shift ----------

fn on_shift() -> Contract {
    let mut c = new_contract(2, 8, MIN, DAY);
    holder(&mut c, "alice.testnet");
    on_call(&mut c, "alice.testnet", MIN, T0);
    c
}

#[test]
#[should_panic(expected = "your shift is not over")]
fn clock_out_before_the_shift_ends_is_refused() {
    let mut c = on_shift();
    assert_eq!(c.get_config().min_shift_ms.0, DAY);
    let d = c.get_desk_at(T0, "alice.testnet");
    assert_eq!((d.on_call_since_ms.0, d.shift_ends_ms.0), (T0, T0 + DAY));
    at("alice.testnet", T0 + DAY - 1, 1);
    c.clock_out();
}

#[test]
fn clock_out_at_exactly_the_end_of_the_shift() {
    let mut c = on_shift();
    at("alice.testnet", T0 + DAY, 1);
    assert!(!c.clock_out().on_call);
}

#[test]
#[should_panic(expected = "your shift is not over")]
fn the_shift_is_checked_before_the_open_tickets() {
    let mut c = on_shift();
    open(&mut c, "CVE-2026-0001", T0 + 2 * HOUR, false);
    at("alice.testnet", T0 + HOUR, 1);
    c.clock_out();
}

#[test]
#[should_panic(expected = "account behind: call settle first")]
fn the_settle_check_comes_before_the_shift() {
    let mut c = new_contract(1, 128, MIN, DAY);
    for i in 0..51u32 {
        open(&mut c, &format!("CVE-2026-{:04}", i + 1), T0 + 2 * HOUR, false);
    }
    pager(&mut c, "alice.testnet");
    at("alice.testnet", T0 + 2 * HOUR, 1);
    c.clock_out();
}

#[test]
#[should_panic(expected = "your shift is not over")]
fn a_top_up_does_not_restart_the_shift_but_rejoining_does() {
    let mut c = on_shift();
    let d = on_call(&mut c, "alice.testnet", 1, T0 + HOUR);
    assert_eq!((d.on_call_since_ms.0, d.shift_ends_ms.0), (T0, T0 + DAY));
    at("alice.testnet", T0 + DAY, 1);
    c.clock_out();
    let d = on_call(&mut c, "alice.testnet", MIN, T0 + 2 * DAY);
    assert_eq!((d.on_call_since_ms.0, d.shift_ends_ms.0, d.first_on_call_ms.0), (T0 + 2 * DAY, T0 + 3 * DAY, T0));
    at("alice.testnet", T0 + 3 * DAY - 1, 1);
    c.clock_out();
}

// ---------- monthly counters ----------

#[test]
fn month_counters_start_over_in_a_new_month() {
    assert_eq!(month::month_of(T0), 202701, "T0 is 2027-01-15");
    let feb = T0 + 20 * DAY; // 2027-02-04
    let mut c = setup();
    open(&mut c, "CVE-2026-0001", T0 + 2 * HOUR, false);
    open(&mut c, "CVE-2026-0002", feb + 2 * HOUR, false);
    pager(&mut c, "alice.testnet");
    close(&mut c, "alice.testnet", 0, Status::Fixed, T0);
    let d = c.get_desk_at(T0, "alice.testnet");
    assert_eq!((d.month, d.month_on_time, d.month_missed, d.month_burned.0), (202701, 1, 0, 0));
    // February: the January answer still counts for life, not for the month
    let d = c.get_desk_at(feb, "alice.testnet");
    assert_eq!((d.month, d.month_on_time, d.on_time), (202702, 0, 1));
    close(&mut c, "alice.testnet", 1, Status::Fixed, feb);
    let r = c.desks.get(&acct("alice.testnet")).unwrap();
    assert_eq!((r.month, r.month_on_time), (202702, 1));
    let d = c.get_desk_at(feb, "alice.testnet");
    assert_eq!((d.month, d.month_on_time, d.on_time), (202702, 1, 2));
}

#[test]
fn a_miss_counts_in_the_month_of_its_deadline_however_late_it_settles() {
    let feb = T0 + 20 * DAY;
    let mut c = many(51); // all due 2027-01-15 10:00
    open(&mut c, "CVE-2026-9999", feb + DAY, false);
    pager(&mut c, "alice.testnet");
    // projected in January: 51 pending misses this month
    let d = c.get_desk_at(T0 + 3 * HOUR, "alice.testnet");
    assert_eq!((d.month, d.month_missed, d.month_burned.0), (202701, 51, d.pending_burn.0));
    assert_eq!((d.missed, d.unsettled), (51, 51));
    // projected in February: the January misses are not this month's
    let d = c.get_desk_at(feb, "alice.testnet");
    assert_eq!((d.month, d.month_missed, d.month_burned.0, d.missed), (202702, 0, 0, 51));
    // a janitor settles 50 of them in February: they count for January, not February
    at("janitor.testnet", feb, 0);
    assert_eq!(c.settle(acct("alice.testnet"), None).settled, 50);
    let r = c.desks.get(&acct("alice.testnet")).unwrap().clone();
    assert_eq!((r.month, r.month_on_time, r.month_missed, r.missed), (202701, 0, 50, 50));
    let d = c.get_desk_at(feb, "alice.testnet");
    assert_eq!((d.month, d.month_missed, d.month_burned.0, d.missed, d.unsettled), (202702, 0, 0, 51, 1));
    // answering in February settles the last January miss first (into January), then counts
    close(&mut c, "alice.testnet", 51, Status::Fixed, feb);
    let r = c.desks.get(&acct("alice.testnet")).unwrap();
    assert_eq!((r.month, r.month_on_time, r.month_missed, r.month_burned, r.missed), (202702, 1, 0, 0, 51));
    let d = c.get_desk_at(feb, "alice.testnet");
    assert_eq!((d.month_on_time, d.month_missed, d.month_burned.0, d.missed), (1, 0, 0, 51));
}

#[test]
fn misses_in_the_current_month_add_to_the_month_counters() {
    let mut c = setup();
    open(&mut c, "CVE-2026-0001", T0 + 2 * HOUR, false);
    open(&mut c, "CVE-2026-0002", T0 + 3 * HOUR, false);
    pager(&mut c, "alice.testnet");
    at("janitor.testnet", T0 + 2 * HOUR, 0);
    c.settle(acct("alice.testnet"), None);
    let first = BAG / 100;
    let second = (BAG - first) / 100;
    // one settled, one pending: both count for January
    let d = c.get_desk_at(T0 + 3 * HOUR, "alice.testnet");
    assert_eq!((d.month, d.month_missed, d.month_burned.0), (202701, 2, first + second));
    assert_eq!((d.pending_burn.0, d.burned.0), (second, first + second));
}

// ---------- roster ----------

#[test]
fn roster_pages_in_first_on_call_order_with_a_cap_of_50() {
    let mut c = setup();
    for i in 0..55 {
        holder(&mut c, &format!("d{i:02}.testnet"));
    }
    for i in (0..55).rev() {
        on_call(&mut c, &format!("d{i:02}.testnet"), MIN, T0 + 100 - i as u64);
    }
    at("d54.testnet", T0 + 200, 1);
    c.clock_out();
    at("viewer.testnet", T0 + 200, 0);
    let page = c.get_roster(0, 1000);
    assert_eq!(page.len(), 50, "limit is capped at 50");
    assert_eq!(page[0].account_id, acct("d54.testnet"));
    assert_eq!(page[49].account_id, acct("d05.testnet"));
    assert!(!page[0].desk.on_call, "a desk that clocked out stays on the roster");
    assert_eq!(page[1].desk, c.get_desk(acct("d53.testnet")));
    assert!(page[1].desk.on_call);
    let rest = c.get_roster(50, 50);
    assert_eq!(
        rest.iter().map(|e| e.account_id.to_string()).collect::<Vec<_>>(),
        ["d04.testnet", "d03.testnet", "d02.testnet", "d01.testnet", "d00.testnet"]
    );
    assert!(c.get_roster(60, 10).is_empty());
    assert!(c.get_roster(u32::MAX, u32::MAX).is_empty());
    let s = c.get_stats();
    assert_eq!((s.roster, s.on_call, s.committed_total.0), (55, 54, 54 * MIN));
}

// ---------- registration cost ----------

fn flush(c: &mut Contract) {
    c.desks.flush();
    c.roster.flush();
    c.statements.flush();
    c.tickets.flush();
    c.expired.flush();
    c.by_cve.flush();
    c.pending.flush();
    c.reporter_pending.flush();
}

#[test]
fn registration_pays_for_the_desk_the_claim_the_roster_entry_and_the_statements() {
    let mut c = setup();
    open(&mut c, "CVE-2026-1111", T0 + 2 * HOUR, false);
    flush(&mut c);
    let long = format!("{}.testnet", "a".repeat(56));
    assert_eq!(long.len(), 64);
    // each step in its own context (storage usage restarts with every context), flushed
    let d = min_deposit(&c);
    at(&long, T0, d);
    let before = env::storage_usage();
    c.storage_deposit(None, None);
    c.claim_starter();
    flush(&mut c);
    let desk_claim = env::storage_usage() - before;
    at(&long, T0, 1);
    let before = env::storage_usage();
    c.go_on_call(U128(MIN));
    flush(&mut c);
    let roster = env::storage_usage() - before;
    let before = env::storage_usage();
    c.close_ticket(0, Status::Fixed);
    flush(&mut c);
    let statement = env::storage_usage() - before;
    // the claim marker is priced with a 1-byte value; LookupSet stores an empty one
    assert_eq!(c.registration_bytes - (desk_claim + roster + PREPAID_STATEMENTS * statement), 1);
    let desk = near_sdk::borsh::to_vec(&DeskRecord::default()).unwrap().len();
    assert_eq!(desk, 125, "the v2 desk record");
}

// ---------- amendment 2 ----------

#[test]
fn nep141_events_stay_at_1_0_0_and_kevin_events_are_2_0_0() {
    let mut c = setup();
    holder(&mut c, "alice.testnet");
    on_call(&mut c, "alice.testnet", MIN, T0);
    let line = get_logs().pop().unwrap();
    assert!(line.starts_with(r#"EVENT_JSON:{"standard":"kevin","version":"2.0.0","event":"on_call""#), "{line}");
    transfer(&mut c, "alice.testnet", ME, 1, T0);
    let line = get_logs().pop().unwrap();
    assert!(line.starts_with(r#"EVENT_JSON:{"standard":"nep141","version":"1.0.0","event":"ft_transfer""#), "{line}");
}

fn panic_text(r: std::thread::Result<Statement>) -> String {
    let e = r.expect_err("should panic");
    e.downcast_ref::<String>().cloned().or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string())).unwrap()
}

#[test]
fn close_while_more_than_50_behind_is_refused_and_counts_nothing() {
    let mut c = many(51);
    let late = open(&mut c, "CVE-2026-9999", T0 + 5 * HOUR, false);
    pager(&mut c, "alice.testnet");
    for id in 0..51 {
        close(&mut c, "alice.testnet", id, Status::Fixed, T0);
    }
    let d = c.get_desk(acct("alice.testnet"));
    assert_eq!((d.on_time, d.streak, d.best_streak), (51, 51, 51));
    // 51 answered tickets expire; settling them all does not fit the 50 the call settles
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        close(&mut c, "alice.testnet", late, Status::Fixed, T0 + 3 * HOUR)
    }));
    // the mock reports a contract panic as a host error that carries the exact message
    assert!(panic_text(r).contains(r#"GuestPanic { panic_msg: "account behind: call settle first" }"#));
    assert_eq!(c.get_statement(acct("alice.testnet"), late), None);
    let d = c.get_desk_at(T0 + 3 * HOUR, "alice.testnet");
    assert_eq!((d.on_time, d.streak, d.best_streak), (51, 51, 51), "nothing counted");
    at("janitor.testnet", T0 + 3 * HOUR, 0);
    c.settle(acct("alice.testnet"), None);
    close(&mut c, "alice.testnet", late, Status::Fixed, T0 + 3 * HOUR);
    let d = c.get_desk_at(T0 + 3 * HOUR, "alice.testnet");
    assert_eq!((d.on_time, d.streak, d.best_streak, d.unsettled), (52, 52, 52, 0));
}

#[test]
#[should_panic(expected = "account behind: call settle first")]
fn close_with_a_miss_due_and_too_little_gas_to_settle_it_is_refused() {
    let mut c = setup();
    open(&mut c, "CVE-2026-0001", T0 + 2 * HOUR, false);
    let late = open(&mut c, "CVE-2026-0002", T0 + 5 * HOUR, false);
    pager(&mut c, "alice.testnet");
    // settlement keeps a 5 Tgas reserve, so with 5 Tgas attached it settles nothing
    testing_env!(context("alice.testnet", T0 + 3 * HOUR, 0).prepaid_gas(near_sdk::Gas::from_tgas(5)).build());
    c.close_ticket(late, Status::Fixed);
}

#[test]
fn close_with_a_miss_due_and_enough_gas_settles_it_first() {
    let mut c = setup();
    open(&mut c, "CVE-2026-0001", T0 + 2 * HOUR, false);
    let late = open(&mut c, "CVE-2026-0002", T0 + 5 * HOUR, false);
    pager(&mut c, "alice.testnet");
    testing_env!(context("alice.testnet", T0 + 3 * HOUR, 0).prepaid_gas(near_sdk::Gas::from_tgas(30)).build());
    c.close_ticket(late, Status::Fixed);
    let d = c.get_desk(acct("alice.testnet"));
    assert_eq!((d.on_time, d.missed, d.streak, d.unsettled), (1, 1, 1, 0));
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn go_on_call_needs_one_yocto() {
    let mut c = setup();
    holder(&mut c, "alice.testnet");
    at("alice.testnet", T0, 0);
    c.go_on_call(U128(MIN));
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn clock_out_needs_one_yocto() {
    let mut c = setup();
    holder(&mut c, "alice.testnet");
    on_call(&mut c, "alice.testnet", MIN, T0);
    at("alice.testnet", T0, 0);
    c.clock_out();
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn go_on_call_refuses_more_than_one_yocto() {
    let mut c = setup();
    holder(&mut c, "alice.testnet");
    at("alice.testnet", T0, 2);
    c.go_on_call(U128(MIN));
}

#[test]
fn a_transfer_does_not_expire_due_tickets() {
    let mut c = setup();
    open(&mut c, "CVE-2026-1111", T0 + 2 * HOUR, false);
    holder(&mut c, "alice.testnet");
    register(&mut c, "bob.testnet");
    transfer(&mut c, "alice.testnet", "bob.testnet", KEV, T0 + 3 * HOUR);
    assert!(event_lines("ticket_expired").is_empty());
    assert_eq!((c.open.len(), c.expired.len()), (1, 0), "still open in state, only due");
    assert_eq!(c.due(T0 + 3 * HOUR), vec![0]);
    let s = c.get_stats();
    assert_eq!((s.tickets_open, s.tickets_expired), (0, 1), "views read the clock");
    at("alice.testnet", T0 + 3 * HOUR, 1);
    let _ = c.ft_transfer_call(acct("bob.testnet"), U128(KEV), None, "".into());
    with_result(ME, T0 + 3 * HOUR, PromiseResult::Failed);
    c.ft_resolve_transfer(acct("alice.testnet"), acct("bob.testnet"), U128(KEV));
    assert_eq!((c.open.len(), c.expired.len()), (1, 0));
    at("janitor.testnet", T0 + 3 * HOUR, 0);
    assert_eq!(c.poke(), 1);
}

#[test]
fn roster_accounts_page_without_projection_with_a_cap_of_100() {
    let mut c = setup();
    for i in 0..105 {
        let who = format!("d{i:03}.testnet");
        holder(&mut c, &who);
        on_call(&mut c, &who, MIN, T0);
    }
    at("viewer.testnet", T0, 0);
    let page = c.get_roster_accounts(0, 1000);
    assert_eq!(page.len(), 100, "limit is capped at 100");
    assert_eq!((page[0].as_str(), page[99].as_str()), ("d000.testnet", "d099.testnet"));
    let rest = c.get_roster_accounts(100, 100);
    assert_eq!(
        rest.iter().map(|a| a.as_str()).collect::<Vec<_>>(),
        ["d100.testnet", "d101.testnet", "d102.testnet", "d103.testnet", "d104.testnet"]
    );
    assert_eq!(c.get_roster_accounts(3, 2), vec![acct("d003.testnet"), acct("d004.testnet")]);
    assert!(c.get_roster_accounts(105, 10).is_empty());
    assert!(c.get_roster_accounts(u32::MAX, u32::MAX).is_empty());
}
