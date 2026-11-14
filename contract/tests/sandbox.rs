// Integration tests on local near-sandbox nodes with the real wasm. Each test starts its own
// sandbox (at most KEVIN_SANDBOXES at once, default 4). Tickets use short windows on chain time
// and the clock is advanced with sandbox fast-forward. Run with `-- --nocapture` to see gas.
#![allow(unused_must_use)]
use futures::future::join_all;
use near_api::types::transaction::actions::{FunctionCallAction, FunctionCallPermission};
use near_api::types::transaction::result::ExecutionFinalResult;
use near_api::types::{AccessKeyPermission, Action};
use near_api::{AccountId, NearGas, NearToken, NetworkConfig, Signer};
use near_sandbox::{GenesisAccount, SandboxConfig};
use near_sdk::serde::de::DeserializeOwned;
use near_sdk::serde_json::{self, Value, json};
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tokio::sync::{Semaphore, SemaphorePermit};

const KEV: u128 = 1_000_000_000_000_000_000;
const BAG: u128 = 10_000 * KEV;
const SUPPLY: u128 = 1_000_000_000 * KEV;
const MIN: u128 = 1_000 * KEV;
/// Chain milliseconds between opening a ticket and its deadline: enough for the "just before
/// the deadline" moves to land in time on a heavily loaded machine running every sandbox test in
/// parallel. Waiting it out costs little, since the clock is fast-forwarded. If setups still run
/// past it, cap the parallelism: `cargo test --test sandbox -- --test-threads=4`.
const LEAD: u64 = 180_000;

// ---------- harness ----------

fn sandboxes() -> &'static Semaphore {
    static S: OnceLock<Semaphore> = OnceLock::new();
    S.get_or_init(|| Semaphore::new(std::env::var("KEVIN_SANDBOXES").ok().and_then(|v| v.parse().ok()).unwrap_or(4)))
}

fn wasm() -> Vec<u8> {
    static WASM: OnceLock<Vec<u8>> = OnceLock::new();
    WASM.get_or_init(|| {
        std::fs::read(cargo_near_build::build_with_cli(Default::default()).expect("wasm build")).expect("read wasm")
    })
    .clone()
}

/// A hand-assembled contract whose `ft_on_transfer` always answers u128::MAX unused: it refuses
/// every transfer, the way a receiver that rejects the deposit does.
fn refuser_wasm() -> Vec<u8> {
    let ret = b"\"340282366920938463463374607431768211455\"";
    assert_eq!(ret.len(), 41);
    let mut w = vec![0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
    w.extend([0x01, 0x09, 0x02, 0x60, 0x02, 0x7e, 0x7e, 0x00, 0x60, 0x00, 0x00]); // types (i64,i64)->(), ()->()
    w.extend([0x02, 0x14, 0x01, 0x03]); // import env.value_return
    w.extend(b"env");
    w.push(0x0c);
    w.extend(b"value_return");
    w.extend([0x00, 0x00]);
    w.extend([0x03, 0x02, 0x01, 0x01]); // one function of type 1
    w.extend([0x05, 0x03, 0x01, 0x00, 0x01]); // one page of memory
    w.extend([0x07, 0x1b, 0x02, 0x0e]); // exports
    w.extend(b"ft_on_transfer");
    w.extend([0x00, 0x01, 0x06]);
    w.extend(b"memory");
    w.extend([0x02, 0x00]);
    w.extend([0x0a, 0x0a, 0x01, 0x08, 0x00, 0x42, 41, 0x42, 0x00, 0x10, 0x00, 0x0b]); // value_return(41, 0)
    w.extend([0x0b, 0x2f, 0x01, 0x00, 0x41, 0x00, 0x0b, 41]); // data at offset 0
    w.extend(ret);
    w
}

/// Exported function names of a wasm module (section 7), read straight from the binary.
fn exports(wasm: &[u8]) -> Vec<String> {
    fn leb(b: &[u8], i: &mut usize) -> usize {
        let (mut v, mut shift) = (0usize, 0);
        loop {
            let byte = b[*i];
            *i += 1;
            v |= ((byte & 0x7f) as usize) << shift;
            if byte & 0x80 == 0 {
                return v;
            }
            shift += 7;
        }
    }
    let mut i = 8;
    while i < wasm.len() {
        let id = wasm[i];
        i += 1;
        let size = leb(wasm, &mut i);
        let end = i + size;
        if id == 7 {
            let mut out = Vec::new();
            for _ in 0..leb(wasm, &mut i) {
                let n = leb(wasm, &mut i);
                let name = String::from_utf8(wasm[i..i + n].to_vec()).unwrap();
                i += n;
                let kind = wasm[i];
                i += 1;
                leb(wasm, &mut i);
                if kind == 0 {
                    out.push(name);
                }
            }
            return out;
        }
        i = end;
    }
    Vec::new()
}

fn id(name: &str) -> AccountId {
    format!("{name}.sandbox").parse().unwrap()
}

fn u(v: &Value) -> u128 {
    v.as_str().unwrap_or_else(|| panic!("expected a decimal string, got {v}")).parse().unwrap()
}

fn tgas(g: NearGas) -> f64 {
    g.as_gas() as f64 / 1e12
}

struct Opts {
    reporters: usize,
    quorum: u8,
    max_open: u16,
    min_window_ms: u64,
    min_shift_ms: u64,
}

const DEFAULT: Opts = Opts { reporters: 3, quorum: 2, max_open: 64, min_window_ms: 1_000, min_shift_ms: 0 };

struct Env {
    sandbox: near_sandbox::Sandbox,
    net: NetworkConfig,
    signer: Arc<Signer>,
    kevin: AccountId,
    _permit: SemaphorePermit<'static>,
}

impl Env {
    /// A sandbox whose genesis holds the contract, the reporters and `names` (one shared key),
    /// with the token deployed and initialised in the same transaction.
    async fn start(opts: Opts, names: &[&str]) -> Env {
        let permit = sandboxes().acquire().await.unwrap();
        let code = tokio::task::spawn_blocking(wasm).await.unwrap();
        let reporters: Vec<String> = (1..=opts.reporters).map(|i| format!("r{i}")).collect();
        let mut all = vec!["kevin".to_string()];
        all.extend(reporters.iter().cloned());
        all.extend(names.iter().map(|s| s.to_string()));
        let cfg = SandboxConfig {
            additional_accounts: all
                .iter()
                .map(|n| GenesisAccount::default_with_name(format!("{n}.sandbox").parse().unwrap()))
                .collect(),
            ..Default::default()
        };
        let sandbox = near_sandbox::Sandbox::start_sandbox_with_config(cfg).await.expect("sandbox");
        let net = NetworkConfig::from_rpc_url("sandbox", sandbox.rpc_addr.parse().unwrap());
        let signer =
            Signer::from_secret_key(near_sandbox::config::DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY.parse().unwrap())
                .unwrap();
        let env = Env { sandbox, net, signer, kevin: id("kevin"), _permit: permit };
        let init = json!({
            "reporters": reporters.iter().map(|r| id(r)).collect::<Vec<_>>(),
            "quorum": opts.quorum,
            "miss_bps": 100,
            "ransom_miss_bps": 500,
            "min_window_ms": opts.min_window_ms.to_string(),
            "max_open": opts.max_open,
            "starter_bag": BAG.to_string(),
            "initial_supply": SUPPLY.to_string(),
            "min_commit": MIN.to_string(),
            "min_shift_ms": opts.min_shift_ms.to_string(),
        });
        near_api::Contract::deploy(env.kevin.clone())
            .use_code(code)
            .with_init_call("new", init)
            .unwrap()
            .with_signer(env.signer.clone())
            .send_to(&env.net)
            .await
            .unwrap()
            .assert_success();
        env
    }

    async fn call_on(
        &self,
        contract: &AccountId,
        who: &AccountId,
        method: &str,
        args: Value,
        deposit: u128,
    ) -> ExecutionFinalResult {
        self.call_gas(contract, who, method, args, deposit, 300).await
    }

    async fn call_gas(
        &self,
        contract: &AccountId,
        who: &AccountId,
        method: &str,
        args: Value,
        deposit: u128,
        tgas: u64,
    ) -> ExecutionFinalResult {
        near_api::Contract(contract.clone())
            .call_function(method, args)
            .transaction()
            .deposit(NearToken::from_yoctonear(deposit))
            .gas(NearGas::from_tgas(tgas))
            .with_signer(who.clone(), self.signer.clone())
            .send_to(&self.net)
            .await
            .unwrap()
            .into_full()
            .unwrap()
    }

    async fn call(&self, who: &AccountId, method: &str, args: Value, deposit: u128) -> ExecutionFinalResult {
        self.call_on(&self.kevin, who, method, args, deposit).await
    }

    async fn ok(&self, who: &AccountId, method: &str, args: Value, deposit: u128) -> ExecutionFinalResult {
        let r = self.call(who, method, args, deposit).await;
        if let Err(e) = r.clone().into_result() {
            panic!("{method} by {who} should succeed: {e}");
        }
        r
    }

    async fn fails(&self, who: &AccountId, method: &str, args: Value, deposit: u128, expected: &str) {
        match self.call(who, method, args, deposit).await.into_result() {
            Ok(_) => panic!("{method} by {who} should fail with {expected:?}, but it succeeded"),
            Err(e) => {
                let text = e.to_string();
                assert!(text.contains(expected), "{method} by {who}: expected {expected:?}, got {text}");
            }
        }
    }

    async fn view<T: DeserializeOwned + Send + Sync>(&self, method: &str, args: Value) -> T {
        near_api::Contract(self.kevin.clone())
            .call_function(method, args)
            .read_only()
            .fetch_from(&self.net)
            .await
            .unwrap()
            .data
    }

    async fn now(&self) -> u64 {
        u(&self.view::<Value>("get_stats", json!({})).await["now_ms"]) as u64
    }

    async fn bal(&self, who: &AccountId) -> u128 {
        u(&self.view::<Value>("ft_balance_of", json!({ "account_id": who })).await)
    }

    async fn supply(&self) -> u128 {
        u(&self.view::<Value>("ft_total_supply", json!({})).await)
    }

    async fn desk(&self, who: &AccountId) -> Value {
        self.view("get_desk", json!({ "account_id": who })).await
    }

    async fn ticket(&self, ticket_id: u32) -> Value {
        self.view("get_ticket", json!({ "ticket_id": ticket_id })).await
    }

    async fn min_deposit(&self) -> u128 {
        u(&self.view::<Value>("storage_balance_bounds", json!({})).await["min"])
    }

    async fn register(&self, who: &AccountId) {
        let d = self.min_deposit().await;
        self.ok(who, "storage_deposit", json!({}), d).await;
    }

    async fn holder(&self, who: &AccountId) {
        self.register(who).await;
        let r = self.ok(who, "claim_starter", json!({}), 0).await;
        assert_eq!(u(&r.json::<Value>().unwrap()), BAG);
    }

    async fn holders(&self, who: &[&AccountId]) {
        join_all(who.iter().map(|w| self.holder(w))).await;
    }

    /// Commits `amount` and returns the desk `go_on_call` answers with.
    async fn on_call(&self, who: &AccountId, amount: u128) -> Value {
        self.ok(who, "go_on_call", json!({ "amount": amount.to_string() }), 1).await.json().unwrap()
    }

    /// A holder with the whole starter bag committed.
    async fn pager(&self, who: &AccountId) {
        self.holder(who).await;
        self.on_call(who, BAG).await;
    }

    async fn pagers(&self, who: &[&AccountId]) {
        join_all(who.iter().map(|w| self.pager(w))).await;
    }

    async fn deploy_refuser(&self, refuser: &AccountId, payer: &AccountId) {
        near_api::Contract::deploy(refuser.clone())
            .use_code(refuser_wasm())
            .without_init_call()
            .with_signer(self.signer.clone())
            .send_to(&self.net)
            .await
            .unwrap()
            .assert_success();
        let d = self.min_deposit().await;
        self.ok(payer, "storage_deposit", json!({ "account_id": refuser }), d).await;
    }

    async fn transfer(&self, from: &AccountId, to: &AccountId, amount: u128) -> ExecutionFinalResult {
        self.ok(from, "ft_transfer", json!({ "receiver_id": to, "amount": amount.to_string() }), 1).await
    }

    fn report(cve: &str, deadline: u64, ransomware: bool) -> Value {
        json!({ "report": {
            "cve_id": cve, "vendor": "Acme", "product": "Widget Server", "date_added": "2026-11-13",
            "due_date": "2026-12-04", "ransomware": ransomware, "deadline_ms": deadline.to_string()
        }})
    }

    /// Opens a ticket through the quorum (r1 then r2) and returns its id and deadline.
    async fn open(&self, cve: &str, ransomware: bool) -> (u32, u64) {
        let deadline = self.now().await + LEAD;
        let r = self
            .ok(&id("r1"), "report_ticket", Self::report(cve, deadline, ransomware), 0)
            .await
            .json::<Value>()
            .unwrap();
        if r["activated"] == true {
            return (r["ticket_id"].as_u64().unwrap() as u32, deadline);
        }
        let r = self
            .ok(&id("r2"), "report_ticket", Self::report(cve, deadline, ransomware), 0)
            .await
            .json::<Value>()
            .unwrap();
        assert_eq!(r["activated"], true, "{r}");
        assert_eq!(r["confirmations"], 2);
        (r["ticket_id"].as_u64().unwrap() as u32, deadline)
    }

    async fn close(&self, who: &AccountId, ticket_id: u32, status: &str) -> ExecutionFinalResult {
        self.ok(who, "close_ticket", json!({ "ticket_id": ticket_id, "status": status }), 0).await
    }

    async fn before(&self, deadline: u64) {
        assert!(self.now().await < deadline, "the setup ran past the deadline; raise LEAD");
    }

    /// Advances the chain clock to at least `t`.
    async fn wait_until(&self, t: u64) {
        loop {
            let now = self.now().await;
            if now >= t {
                return;
            }
            let gap = t - now;
            // one fast-forwarded block moves the clock about 300 to 400 ms, and large jumps get
            // slow (1000 blocks took about two minutes), so jump in small steps
            if gap > 2_000 {
                self.sandbox.fast_forward((gap / 400).clamp(1, 100)).await.unwrap();
            } else {
                tokio::time::sleep(Duration::from_millis(gap + 200)).await;
            }
        }
    }

    async fn settle(&self, who: &AccountId) -> Value {
        self.ok(&id("r3"), "settle", json!({ "account_id": who }), 0).await.json().unwrap()
    }

    /// Signs `method` with `key` and broadcasts it over raw JSON-RPC, so the node's own
    /// rejection reason is visible (the client library reduces it to a bare InvalidTransaction).
    async fn raw_send(&self, who: &AccountId, key: Arc<Signer>, method: &str, args: Value, deposit: u128) -> String {
        let signed = near_api::Contract(self.kevin.clone())
            .call_function(method, args)
            .transaction()
            .deposit(NearToken::from_yoctonear(deposit))
            .gas(NearGas::from_tgas(50))
            .with_signer(who.clone(), key)
            .presign_with(&self.net)
            .await
            .unwrap()
            .transaction;
        let near_api::advanced::TransactionableOrSigned::Signed((signed, _)) = signed else {
            unreachable!("presigned")
        };
        let b64 = near_sdk::base64::Engine::encode(
            &near_sdk::base64::engine::general_purpose::STANDARD,
            near_sdk::borsh::to_vec(&signed).unwrap(),
        );
        let body =
            json!({ "jsonrpc": "2.0", "id": "kevin", "method": "broadcast_tx_commit", "params": [b64] }).to_string();
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let host = self.sandbox.rpc_addr.trim_start_matches("http://").trim_end_matches('/').to_string();
        let mut s = tokio::net::TcpStream::connect(&host).await.unwrap();
        let req = format!(
            "POST / HTTP/1.1\r\nHost: {host}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        s.write_all(req.as_bytes()).await.unwrap();
        let mut out = Vec::new();
        s.read_to_end(&mut out).await.unwrap();
        String::from_utf8_lossy(&out).into_owned()
    }
}

/// NEP-141 events stay at 1.0.0; the contract's own `kevin` events are 2.0.0.
fn version(standard: &str) -> &'static str {
    if standard == "nep141" { "1.0.0" } else { "2.0.0" }
}

fn fc(method: &str, args: Value, deposit: u128, tgas: u64) -> Action {
    Action::FunctionCall(Box::new(FunctionCallAction {
        method_name: method.to_string(),
        args: serde_json::to_vec(&args).unwrap(),
        gas: NearGas::from_tgas(tgas),
        deposit: NearToken::from_yoctonear(deposit),
    }))
}

fn has_event(r: &ExecutionFinalResult, standard: &str, event: &str) -> bool {
    r.logs().iter().any(|l| {
        l.strip_prefix("EVENT_JSON:")
            .and_then(|s| serde_json::from_str::<Value>(s).ok())
            .is_some_and(|v| v["standard"] == standard && v["version"] == version(standard) && v["event"] == event)
    })
}

// ---------- happy paths ----------

/// Quorum opens a ticket, one desk on call answers, the deadline passes, the silent desk burns
/// exactly 1% of what it committed, the answering desk is untouched, total supply falls by
/// exactly the burn.
#[tokio::test]
async fn happy_path_quorum_close_expire_burn() {
    let e = Env::start(DEFAULT, &["alice", "bob"]).await;
    let (alice, bob) = (id("alice"), id("bob"));
    e.pagers(&[&alice, &bob]).await;
    assert_eq!(e.bal(&e.kevin).await, SUPPLY - 2 * BAG);

    let deadline = e.now().await + LEAD;
    let r = e.ok(&id("r1"), "report_ticket", Env::report("CVE-2026-41111", deadline, false), 0).await;
    assert_eq!(r.json::<Value>().unwrap(), json!({ "activated": false, "ticket_id": null, "confirmations": 1 }));
    let r = e.ok(&id("r2"), "report_ticket", Env::report("CVE-2026-41111", deadline, false), 0).await;
    assert!(has_event(&r, "kevin", "ticket_opened"));
    assert_eq!(r.json::<Value>().unwrap(), json!({ "activated": true, "ticket_id": 0, "confirmations": 2 }));
    let open: Vec<Value> = e.view("get_open_tickets", json!({})).await;
    assert_eq!(open.len(), 1);
    assert_eq!(open[0]["burn_bps"], 100);
    assert_eq!(open[0]["state"], "open");

    let r = e.close(&alice, 0, "not_affected").await;
    assert!(has_event(&r, "kevin", "statement"));
    assert_eq!(r.json::<Value>().unwrap()["status"], "not_affected");
    e.before(deadline).await;
    let supply = e.supply().await;
    e.wait_until(deadline).await;

    // views see the expiry and the burn before anyone pokes
    assert_eq!(e.ticket(0).await["state"], "expired");
    assert_eq!(e.bal(&bob).await, BAG - BAG / 100);
    assert_eq!(u(&e.desk(&bob).await["pending_burn"]), BAG / 100);
    assert_eq!(e.supply().await, supply);

    let r = e.ok(&id("r3"), "poke", json!({}), 0).await;
    assert_eq!(r.clone().json::<u32>().unwrap(), 1);
    assert!(has_event(&r, "kevin", "ticket_expired"));
    let r = e.ok(&id("r3"), "settle", json!({ "account_id": bob }), 0).await;
    assert!(has_event(&r, "nep141", "ft_burn") && has_event(&r, "kevin", "missed"));
    assert!(
        r.logs()
            .iter()
            .any(|l| l.starts_with(r#"EVENT_JSON:{"standard":"nep141","version":"1.0.0","event":"ft_burn""#))
    );
    assert!(
        r.logs().iter().any(|l| l.starts_with(r#"EVENT_JSON:{"standard":"kevin","version":"2.0.0","event":"missed""#))
    );
    assert!(r.logs().iter().any(|l| l.contains("\"memo\":\"missed CVE-2026-41111\"")));
    assert_eq!(r.json::<Value>().unwrap(), json!({ "settled": 1, "remaining": 0, "burned": (BAG / 100).to_string() }));
    e.settle(&alice).await;

    assert_eq!(e.bal(&bob).await, BAG - BAG / 100);
    assert_eq!(e.bal(&alice).await, BAG);
    assert_eq!(e.supply().await, supply - BAG / 100);
    let t = e.ticket(0).await;
    assert_eq!((t["closes"].clone(), t["not_affected"].clone(), t["missed"].clone()), (json!(1), json!(1), json!(1)));
    assert_eq!(u(&t["burned"]), BAG / 100);
    let s: Value = e.view("get_stats", json!({})).await;
    assert_eq!(u(&s["burned_total"]), BAG / 100);
    assert_eq!(
        (s["tickets_expired"].clone(), s["statements_total"].clone(), s["accounts"].clone()),
        (json!(1), json!(1), json!(2))
    );
    assert_eq!((s["on_call"].clone(), s["roster"].clone(), s["misses_total"].clone()), (json!(2), json!(2), json!(1)));
    assert_eq!(u(&s["committed_total"]), 2 * BAG - BAG / 100);
    let d = e.desk(&alice).await;
    assert_eq!((d["on_time"].clone(), d["streak"].clone(), d["missed"].clone()), (json!(1), json!(1), json!(0)));
    assert_eq!((d["month_on_time"].clone(), d["on_call"].clone()), (json!(1), json!(true)));
    let d = e.desk(&bob).await;
    assert_eq!((d["on_time"].clone(), d["missed"].clone(), u(&d["burned"])), (json!(0), json!(1), BAG / 100));
    let roster: Vec<Value> = e.view("get_roster", json!({ "from_index": 0, "limit": 25 })).await;
    assert_eq!(roster.len(), 2);
    assert_eq!(roster.iter().filter(|r| r["account_id"] == json!(bob)).count(), 1);
}

#[tokio::test]
async fn ransomware_ticket_burns_five_percent() {
    let e = Env::start(DEFAULT, &["bob"]).await;
    let bob = id("bob");
    e.pager(&bob).await;
    let (tid, deadline) = e.open("CVE-2026-46666", true).await;
    assert_eq!(e.ticket(tid).await["burn_bps"], 500);
    e.wait_until(deadline).await;
    assert_eq!(u(&e.settle(&bob).await["burned"]), BAG * 5 / 100);
    assert_eq!(e.bal(&bob).await, BAG * 95 / 100);
    assert_eq!(e.supply().await, SUPPLY - BAG * 5 / 100);
}

#[tokio::test]
async fn burns_compound_over_two_tickets() {
    let e = Env::start(DEFAULT, &["bob"]).await;
    let bob = id("bob");
    e.pager(&bob).await;
    let (_, d1) = e.open("CVE-2026-40001", false).await;
    let (_, d2) = e.open("CVE-2026-40002", true).await;
    e.wait_until(d1.max(d2)).await;
    let after_first = BAG - BAG / 100;
    let expected = after_first - after_first * 5 / 100;
    assert_eq!(e.bal(&bob).await, expected, "projection compounds before settlement");
    let r = e.settle(&bob).await;
    assert_eq!((r["settled"].clone(), u(&r["burned"])), (json!(2), BAG - expected));
    assert_eq!(e.bal(&bob).await, expected);
    assert_eq!(e.supply().await, SUPPLY - (BAG - expected));
}

// ---------- the cheats ----------

/// 1. Moving committed tokens before a deadline: a transfer (plain or with a call) of more than
///    the free balance fails, the free balance moves (and a refused call refunds it in full),
///    and the miss burns 1% of what stayed committed.
#[tokio::test]
async fn cheat_01_move_committed_before_deadline() {
    let e = Env::start(DEFAULT, &["alice", "bob", "refuser"]).await;
    let (alice, bob, refuser) = (id("alice"), id("bob"), id("refuser"));
    e.holder(&alice).await;
    e.register(&bob).await;
    e.deploy_refuser(&refuser, &alice).await;
    e.on_call(&alice, 4_000 * KEV).await;
    let (_, deadline) = e.open("CVE-2026-40101", false).await;
    let free = 6_000 * KEV;
    let committed_text = "not enough free balance: committed tokens cannot move";
    let to_bob = |amount: u128| json!({ "receiver_id": bob, "amount": amount.to_string() });
    e.fails(&alice, "ft_transfer", to_bob(free + 1), 1, committed_text).await;
    e.fails(&alice, "ft_transfer", to_bob(BAG), 1, committed_text).await;
    e.fails(&alice, "ft_transfer", to_bob(BAG + 1), 1, "The account doesn't have enough balance").await;
    let call = |amount: u128| json!({ "receiver_id": refuser, "amount": amount.to_string(), "msg": "" });
    e.fails(&alice, "ft_transfer_call", call(free + 1), 1, committed_text).await;
    let r = e.ok(&alice, "ft_transfer_call", call(free), 1).await;
    assert!(r.logs().iter().any(|l| l.contains("\"memo\":\"refund\"")));
    assert_eq!(u(&r.json::<Value>().unwrap()), 0, "the refuser handed everything back");
    e.transfer(&alice, &bob, free).await;
    e.before(deadline).await;
    e.wait_until(deadline).await;
    assert_eq!(u(&e.settle(&alice).await["burned"]), 40 * KEV);
    assert_eq!(e.bal(&alice).await, 3_960 * KEV);
    assert_eq!(e.bal(&bob).await, free);
    assert_eq!(e.supply().await, SUPPLY - 40 * KEV);
}

/// 2. Clocking out just before a deadline with an unanswered open ticket is refused; the miss
///    burns.
#[tokio::test]
async fn cheat_02_clock_out_before_deadline() {
    let e = Env::start(DEFAULT, &["alice"]).await;
    let alice = id("alice");
    e.pager(&alice).await;
    let (_, deadline) = e.open("CVE-2026-40201", false).await;
    e.fails(&alice, "clock_out", json!({}), 1, "answer every open ticket before you clock out").await;
    e.before(deadline).await;
    e.wait_until(deadline).await;
    assert_eq!(u(&e.settle(&alice).await["burned"]), BAG / 100);
    let d = e.desk(&alice).await;
    assert_eq!((d["on_call"].clone(), u(&d["committed"]), u(&d["balance"])), (json!(true), BAG - BAG / 100, 0));
    assert_eq!(e.supply().await, SUPPLY - BAG / 100);
}

/// 3. Answering without a stake: a registered desk that is not on call cannot close a ticket,
///    so nobody builds a record for free.
#[tokio::test]
async fn cheat_03_answer_without_a_stake() {
    let e = Env::start(DEFAULT, &["alice", "ghost"]).await;
    let (alice, ghost) = (id("alice"), id("ghost"));
    e.holder(&alice).await;
    let (tid, _) = e.open("CVE-2026-40301", false).await;
    let args = json!({ "ticket_id": tid, "status": "fixed" });
    e.fails(&alice, "close_ticket", args.clone(), 0, "go on call first: go_on_call").await;
    e.fails(&ghost, "close_ticket", args.clone(), 0, "register first: storage_deposit").await;
    assert_eq!(e.view::<Value>("get_statement", json!({ "account_id": alice, "ticket_id": tid })).await, Value::Null);
    let d = e.desk(&alice).await;
    assert_eq!((d["on_time"].clone(), d["month_on_time"].clone(), u(&d["balance"])), (json!(0), json!(0), BAG));
    let t = e.ticket(tid).await;
    assert_eq!(t["closes"], 0);
}

/// 4. Answering after the deadline is refused, poked or not.
#[tokio::test]
async fn cheat_04_close_after_deadline() {
    let e = Env::start(DEFAULT, &["alice"]).await;
    let alice = id("alice");
    e.pager(&alice).await;
    let (tid, deadline) = e.open("CVE-2026-40401", false).await;
    e.wait_until(deadline).await;
    e.fails(&alice, "close_ticket", json!({ "ticket_id": tid, "status": "fixed" }), 0, "deadline passed").await;
    e.ok(&id("r3"), "poke", json!({}), 0).await;
    e.fails(&alice, "close_ticket", json!({ "ticket_id": tid, "status": "fixed" }), 0, "deadline passed").await;
    assert_eq!(e.view::<Value>("get_statement", json!({ "account_id": alice, "ticket_id": tid })).await, Value::Null);
    e.fails(&alice, "close_ticket", json!({ "ticket_id": 99, "status": "fixed" }), 0, "no such ticket").await;
    e.fails(
        &id("r3"),
        "close_ticket",
        json!({ "ticket_id": tid, "status": "fixed" }),
        0,
        "register first: storage_deposit",
    )
    .await;
}

/// 5. The oracle rules: one reporter cannot open alone, outsiders cannot report, nobody
///    confirms twice, the burn rate is not the reporter's to set, the window has a floor and a
///    CVE gets one ticket.
#[tokio::test]
async fn cheat_05_reporter_abuse() {
    let e = Env::start(DEFAULT, &["mallory"]).await;
    let (r1, r2) = (id("r1"), id("r2"));
    let deadline = e.now().await + LEAD;
    let rep = Env::report("CVE-2026-40501", deadline, false);
    e.fails(&id("mallory"), "report_ticket", rep.clone(), 0, "not a reporter").await;
    let r = e.ok(&r1, "report_ticket", rep.clone(), 0).await.json::<Value>().unwrap();
    assert_eq!(r["activated"], false);
    assert_eq!(e.view::<Value>("get_ticket_by_cve", json!({ "cve_id": "CVE-2026-40501" })).await, Value::Null);
    e.fails(&r1, "report_ticket", rep.clone(), 0, "already confirmed").await;
    // an extra burn_bps field is ignored: the rate comes from the config
    let mut cheap = rep.clone();
    cheap["report"]["burn_bps"] = json!(0);
    let r = e.ok(&r2, "report_ticket", cheap, 0).await.json::<Value>().unwrap();
    assert_eq!(r["activated"], true);
    assert_eq!(e.ticket(0).await["burn_bps"], 100);
    e.fails(&id("r3"), "report_ticket", Env::report("CVE-2026-40501", deadline + 5_000, false), 0, "ticket exists")
        .await;
    let now = e.now().await;
    e.fails(&r1, "report_ticket", Env::report("CVE-2026-40502", now + 10, false), 0, "window too short").await;
    let mut bad = Env::report("CVE-2026-40503", deadline, false);
    bad["report"]["cve_id"] = json!("CVE-26-1");
    e.fails(&r1, "report_ticket", bad, 0, "bad cve id").await;
    let mut long = Env::report("CVE-2026-40504", deadline, false);
    long["report"]["vendor"] = json!("v".repeat(81));
    e.fails(&r1, "report_ticket", long, 0, "field too long").await;
}

/// 6. A corrupt quorum can open junk tickets, but a desk on call that answers them loses
///    nothing, and `max_open` caps how many can be open at once.
#[tokio::test]
async fn cheat_06_corrupt_quorum_costs_a_click_not_tokens() {
    let e = Env::start(Opts { max_open: 3, ..DEFAULT }, &["alice", "bob"]).await;
    let (alice, bob) = (id("alice"), id("bob"));
    e.pagers(&[&alice, &bob]).await;
    let mut last = 0;
    for i in 1..=3 {
        let (tid, deadline) = e.open(&format!("CVE-2026-4060{i}"), true).await;
        e.close(&alice, tid, "not_affected").await;
        last = last.max(deadline);
    }
    let deadline = e.now().await + LEAD;
    e.ok(&id("r1"), "report_ticket", Env::report("CVE-2026-40604", deadline, true), 0).await;
    e.fails(&id("r2"), "report_ticket", Env::report("CVE-2026-40604", deadline, true), 0, "too many open tickets")
        .await;
    e.before(last).await;
    e.wait_until(last).await;
    e.settle(&alice).await;
    e.settle(&bob).await;
    assert_eq!(e.bal(&alice).await, BAG, "the attentive desk lost nothing");
    let mut b = BAG;
    for _ in 0..3 {
        b -= b * 5 / 100;
    }
    assert_eq!(e.bal(&bob).await, b);
}

/// 7. The on-call key: a function-call key limited to `close_ticket` answers tickets but can
///    never move tokens, change the commitment or clock out.
#[tokio::test]
async fn cheat_07_oncall_key_cannot_transfer_commit_or_clock_out() {
    let e = Env::start(DEFAULT, &["alice", "bob"]).await;
    let (alice, bob) = (id("alice"), id("bob"));
    e.holder(&alice).await;
    e.on_call(&alice, MIN).await;
    e.register(&bob).await;
    let (tid, _) = e.open("CVE-2026-40701", false).await;
    let key = near_api::signer::generate_secret_key().unwrap();
    near_api::Account(alice.clone())
        .add_key(
            AccessKeyPermission::FunctionCall(FunctionCallPermission {
                allowance: Some(NearToken::from_millinear(250)),
                receiver_id: e.kevin.to_string(),
                method_names: vec!["close_ticket".to_string()],
            }),
            key.public_key(),
        )
        .with_signer(e.signer.clone())
        .send_to(&e.net)
        .await
        .unwrap()
        .assert_success();
    let oncall = Signer::from_secret_key(key).unwrap();
    near_api::Contract(e.kevin.clone())
        .call_function("close_ticket", json!({ "ticket_id": tid, "status": "mitigated" }))
        .transaction()
        .gas(NearGas::from_tgas(30))
        .with_signer(alice.clone(), oncall.clone())
        .send_to(&e.net)
        .await
        .unwrap()
        .assert_success();
    assert_eq!(
        e.view::<Value>("get_statement", json!({ "account_id": alice, "ticket_id": tid })).await["status"],
        "mitigated"
    );

    let args = json!({ "receiver_id": bob, "amount": "1" });
    let resp = e.raw_send(&alice, oncall.clone(), "ft_transfer", args.clone(), 1).await;
    assert!(resp.contains("InvalidAccessKeyError") && resp.contains("DepositWithFunctionCall"), "{resp}");
    let resp = e.raw_send(&alice, oncall.clone(), "ft_transfer", args, 0).await;
    assert!(resp.contains("InvalidAccessKeyError") && resp.contains("MethodNameMismatch"), "{resp}");
    let commit = json!({ "amount": "1" });
    for (method, args) in [("go_on_call", commit.clone()), ("clock_out", json!({}))] {
        let resp = e.raw_send(&alice, oncall.clone(), method, args.clone(), 1).await;
        assert!(resp.contains("InvalidAccessKeyError") && resp.contains("DepositWithFunctionCall"), "{resp}");
        let resp = e.raw_send(&alice, oncall.clone(), method, args, 0).await;
        assert!(resp.contains("InvalidAccessKeyError") && resp.contains("MethodNameMismatch"), "{resp}");
    }
    let resp = e.raw_send(&alice, oncall, "storage_unregister", json!({}), 1).await;
    assert!(resp.contains("InvalidAccessKeyError"), "{resp}");

    // a function-call key for every method of the contract still cannot attach the 1 yoctoNEAR
    // that committing and clocking out require
    let key = near_api::signer::generate_secret_key().unwrap();
    near_api::Account(alice.clone())
        .add_key(
            AccessKeyPermission::FunctionCall(FunctionCallPermission {
                allowance: Some(NearToken::from_millinear(250)),
                receiver_id: e.kevin.to_string(),
                method_names: vec![],
            }),
            key.public_key(),
        )
        .with_signer(e.signer.clone())
        .send_to(&e.net)
        .await
        .unwrap()
        .assert_success();
    let any = Signer::from_secret_key(key).unwrap();
    for (method, args) in [("go_on_call", commit), ("clock_out", json!({}))] {
        let resp = e.raw_send(&alice, any.clone(), method, args.clone(), 1).await;
        assert!(resp.contains("InvalidAccessKeyError") && resp.contains("DepositWithFunctionCall"), "{resp}");
        let resp = e.raw_send(&alice, any.clone(), method, args, 0).await;
        assert!(resp.contains("Requires attached deposit of exactly 1 yoctoNEAR"), "{resp}");
    }
    assert_eq!(e.bal(&alice).await, BAG);
    assert_eq!(e.bal(&bob).await, 0);
    let d = e.desk(&alice).await;
    assert_eq!((d["on_call"].clone(), u(&d["committed"]), u(&d["balance"])), (json!(true), MIN, BAG - MIN));
}

/// 8. Going on call after a ticket expired is not liable for it: the cursor starts at the end.
#[tokio::test]
async fn cheat_08_go_on_call_after_expiry_is_not_liable() {
    let e = Env::start(DEFAULT, &["alice", "bob"]).await;
    let (alice, bob) = (id("alice"), id("bob"));
    e.holder(&alice).await;
    e.pager(&bob).await;
    let (_, deadline) = e.open("CVE-2026-40801", false).await;
    e.before(deadline).await;
    e.wait_until(deadline).await;
    let d = e.on_call(&alice, BAG).await;
    assert_eq!((d["unsettled"].clone(), d["missed"].clone(), u(&d["committed"])), (json!(0), json!(0), BAG));
    let r = e.settle(&alice).await;
    assert_eq!(r, json!({ "settled": 0, "remaining": 0, "burned": "0" }));
    assert_eq!(e.bal(&alice).await, BAG);
    assert_eq!(u(&e.settle(&bob).await["burned"]), BAG / 100, "bob was on call in time and burns");
}

/// 9. Topping up right before settling a miss that is already due: the top-up settles first, so
///    the miss burns at the OLD committed amount.
#[tokio::test]
async fn cheat_09_top_up_before_settling_burns_the_old_amount() {
    let e = Env::start(DEFAULT, &["alice"]).await;
    let alice = id("alice");
    e.holder(&alice).await;
    e.on_call(&alice, MIN).await;
    let (_, deadline) = e.open("CVE-2026-40901", false).await;
    e.before(deadline).await;
    e.wait_until(deadline).await;
    let r = e.ok(&alice, "go_on_call", json!({ "amount": (5_000 * KEV).to_string() }), 1).await;
    assert!(has_event(&r, "nep141", "ft_burn") && has_event(&r, "kevin", "on_call"));
    let d = r.json::<Value>().unwrap();
    assert_eq!(
        (u(&d["committed"]), u(&d["burned"]), d["unsettled"].clone()),
        (MIN - MIN / 100 + 5_000 * KEV, MIN / 100, json!(0))
    );
    assert_eq!(e.supply().await, SUPPLY - MIN / 100);
    assert_eq!(e.bal(&alice).await, BAG - MIN / 100);
}

/// 10. Clocking out with a clean queue, then a ticket expires: no burn and the tokens came back
///     intact; rejoining later is liable only for what expires after rejoining.
#[tokio::test]
async fn cheat_10_clean_clock_out_then_rejoin() {
    let e = Env::start(DEFAULT, &["alice"]).await;
    let alice = id("alice");
    e.holder(&alice).await;
    e.on_call(&alice, 4_000 * KEV).await;
    let (t1, d1) = e.open("CVE-2026-41001", false).await;
    e.close(&alice, t1, "fixed").await;
    let r = e.ok(&alice, "clock_out", json!({}), 1).await;
    assert!(has_event(&r, "kevin", "clocked_out"));
    assert!(r.logs().iter().any(|l| l.contains(&format!("\"returned\":\"{}\"", 4_000 * KEV))));
    let d = r.json::<Value>().unwrap();
    assert_eq!((d["on_call"].clone(), u(&d["balance"]), u(&d["committed"])), (json!(false), BAG, 0));
    let (_, d2) = e.open("CVE-2026-41002", false).await;
    e.wait_until(d1.max(d2)).await;
    assert_eq!(e.settle(&alice).await, json!({ "settled": 0, "remaining": 0, "burned": "0" }));
    assert_eq!(e.bal(&alice).await, BAG);
    let d = e.on_call(&alice, 4_000 * KEV).await;
    assert_eq!((d["unsettled"].clone(), d["on_time"].clone()), (json!(0), json!(1)));
    let (_, d3) = e.open("CVE-2026-41003", false).await;
    e.wait_until(d3).await;
    assert_eq!(u(&e.settle(&alice).await["burned"]), 40 * KEV);
    assert_eq!(e.supply().await, SUPPLY - 40 * KEV);
}

/// 11. Free tokens are never burned: 6,000 free and 4,000 committed, one miss costs 1% of the
///     4,000.
#[tokio::test]
async fn cheat_11_free_tokens_never_burn() {
    let e = Env::start(DEFAULT, &["alice"]).await;
    let alice = id("alice");
    e.holder(&alice).await;
    e.on_call(&alice, 4_000 * KEV).await;
    let (_, deadline) = e.open("CVE-2026-41101", false).await;
    e.before(deadline).await;
    e.wait_until(deadline).await;
    let d = e.desk(&alice).await;
    assert_eq!(
        (u(&d["balance"]), u(&d["committed"]), u(&d["stored_committed"]), u(&d["pending_burn"])),
        (6_000 * KEV, 3_960 * KEV, 4_000 * KEV, 40 * KEV)
    );
    assert_eq!(e.bal(&alice).await, 9_960 * KEV);
    assert_eq!(u(&e.settle(&alice).await["burned"]), 40 * KEV);
    assert_eq!(u(&e.desk(&alice).await["balance"]), 6_000 * KEV);
    assert_eq!(e.supply().await, SUPPLY - 40 * KEV);
}

/// 12. Tokens parked in the contract's own (exempt) account are a one-way donation: the wasm
///     exports no owner, admin, upgrade or withdraw method, the only pool exit is the
///     once-per-account starter bag, and an `ft_transfer_call` into the pool is refunded.
#[tokio::test]
async fn cheat_12_pool_is_a_one_way_door() {
    let e = Env::start(DEFAULT, &["alice"]).await;
    let alice = id("alice");
    e.holder(&alice).await;
    let r = e.ok(&alice, "ft_transfer_call", json!({ "receiver_id": e.kevin, "amount": "1000", "msg": "" }), 1).await;
    assert_eq!(u(&r.json::<Value>().unwrap()), 0, "the pool has no ft_on_transfer: refunded in full");
    assert_eq!(e.bal(&alice).await, BAG);
    e.transfer(&alice, &e.kevin, BAG).await;
    assert_eq!(e.bal(&e.kevin).await, SUPPLY);
    assert_eq!(e.bal(&alice).await, 0);
    e.fails(&alice, "claim_starter", json!({}), 0, "starter already claimed").await;
    e.fails(
        &alice,
        "ft_resolve_transfer",
        json!({ "sender_id": alice, "receiver_id": e.kevin, "amount": BAG.to_string() }),
        0,
        "is private",
    )
    .await;
    e.fails(&alice, "new", json!({}), 0, "Method new is private").await;
    // desks are permanent, so there is no unregister and register again to reset the claim
    e.fails(&alice, "storage_unregister", json!({}), 1, "desks are permanent").await;
    e.fails(&alice, "claim_starter", json!({}), 0, "starter already claimed").await;

    let mut methods = exports(&wasm());
    methods.sort();
    let expected = [
        "claim_starter",
        "clock_out",
        "close_ticket",
        "ft_balance_of",
        "ft_metadata",
        "ft_resolve_transfer",
        "ft_total_supply",
        "ft_transfer",
        "ft_transfer_call",
        "get_config",
        "get_desk",
        "get_open_tickets",
        "get_roster",
        "get_roster_accounts",
        "get_statement",
        "get_statements",
        "get_stats",
        "get_ticket",
        "get_ticket_by_cve",
        "get_tickets",
        "go_on_call",
        "new",
        "poke",
        "report_ticket",
        "settle",
        "storage_balance_bounds",
        "storage_balance_of",
        "storage_deposit",
        "storage_unregister",
        "storage_withdraw",
    ];
    let mut expected: Vec<String> = expected.iter().map(|s| s.to_string()).collect();
    expected.push("contract_source_metadata".to_string());
    expected.sort();
    methods.retain(|m| m != "__contract_abi");
    assert_eq!(methods, expected, "no other way in or out");
}

/// 13. Going on call, answering what is open and clocking out right away to skip the tickets
///     that follow: refused until the shift is over, and a ticket that then expires unanswered
///     burns.
#[tokio::test]
async fn cheat_13_clock_out_before_the_shift_ends() {
    let shift = 2 * LEAD;
    let e = Env::start(Opts { min_shift_ms: shift, ..DEFAULT }, &["alice"]).await;
    let alice = id("alice");
    e.holder(&alice).await;
    let (t1, _) = e.open("CVE-2026-41301", false).await;
    let d = e.on_call(&alice, BAG).await;
    let ends = u(&d["shift_ends_ms"]) as u64;
    assert_eq!(ends, u(&d["on_call_since_ms"]) as u64 + shift);
    assert_eq!(u(&e.view::<Value>("get_config", json!({})).await["min_shift_ms"]) as u64, shift);
    e.close(&alice, t1, "fixed").await;
    assert!(e.now().await < ends, "the setup ran past the shift; raise it");
    e.fails(&alice, "clock_out", json!({}), 1, "your shift is not over").await;
    let (_, d2) = e.open("CVE-2026-41302", false).await;
    e.wait_until(d2).await;
    assert_eq!(u(&e.settle(&alice).await["burned"]), BAG / 100);
    // once the shift is over, with nothing open, the desk can leave
    e.wait_until(ends).await;
    let d = e.ok(&alice, "clock_out", json!({}), 1).await.json::<Value>().unwrap();
    assert_eq!(
        (d["on_call"].clone(), u(&d["balance"]), d["shift_ends_ms"].clone()),
        (json!(false), BAG - BAG / 100, json!("0"))
    );
}

/// `settle(limit = 200)` over a full day of misses (128, the daily activation cap at
/// max_open = 128) at 300, 100 and 30 Tgas attached. The first call also expires all 128 tickets
/// in the same receipt, the worst case for writing modified tickets back. Every call succeeds
/// with a partial result, none runs out of gas, and together they burn exactly the compounded
/// amount. The per-call cost is bounded by the log budget and the gas reserve, not by the
/// backlog, so a longer backlog only means more calls.
#[tokio::test]
async fn settle_limit_200_never_runs_out_of_gas() {
    let e = Env::start(Opts { reporters: 5, quorum: 1, max_open: 128, ..DEFAULT }, &["bob"]).await;
    let bob = id("bob");
    e.pager(&bob).await;
    let deadline = e.now().await + 180_000;
    join_all((1..=5u32).map(|r| {
        let e = &e;
        async move {
            for i in (0..128u32).filter(|i| i % 5 == r - 1) {
                let cve = format!("CVE-2026-6{i:04}");
                e.ok(&id(&format!("r{r}")), "report_ticket", Env::report(&cve, deadline, false), 0).await;
            }
        }
    }))
    .await;
    e.fails(&id("r1"), "report_ticket", Env::report("CVE-2026-69999", deadline, false), 0, "too many open tickets")
        .await;
    e.before(deadline).await;
    e.wait_until(deadline).await;
    assert_eq!(e.desk(&bob).await["unsettled"], 128);
    let mut total = 0u32;
    for tgas_budget in [300u64, 100, 30] {
        let r =
            e.call_gas(&e.kevin, &id("r1"), "settle", json!({ "account_id": bob, "limit": 200 }), 0, tgas_budget).await;
        let gas = r.total_gas_burnt;
        let r = r.into_result().unwrap_or_else(|err| panic!("settle at {tgas_budget} Tgas failed: {err}"));
        let s = r.json::<Value>().unwrap();
        let settled = s["settled"].as_u64().unwrap() as u32;
        assert!(settled > 0, "settle at {tgas_budget} Tgas made no progress");
        total += settled;
        assert_eq!(s["remaining"].as_u64().unwrap() as u32, 128 - total);
        println!("GAS settle limit 200 at {tgas_budget} Tgas attached: settled {settled}, burnt {:.2} Tgas", tgas(gas));
    }
    while e.desk(&bob).await["unsettled"] != 0 {
        e.settle(&bob).await;
    }
    let mut b = BAG;
    for _ in 0..128 {
        b -= b / 100;
    }
    assert_eq!(e.bal(&bob).await, b);
    assert_eq!(e.supply().await, SUPPLY - (BAG - b));
}

// ---------- gas ----------

/// Prints the gas of `go_on_call` (first time, joining the roster, and a top-up),
/// `close_ticket`, `ft_transfer`, `clock_out` (nothing due, and settling 50 missed tickets
/// inside), `poke` over 50 tickets and `settle` over 50 missed tickets. A second wave of 50
/// tickets shows `ft_transfer` and `close_ticket` with 50 tickets due but not poked: the
/// transfer does not expire them, the answer does.
#[tokio::test]
async fn gas_report() {
    let e = Env::start(Opts { reporters: 5, quorum: 1, max_open: 128, ..DEFAULT }, &["alice", "bob", "carol", "dave"])
        .await;
    let (alice, bob, carol, dave) = (id("alice"), id("bob"), id("carol"), id("dave"));
    e.holders(&[&alice, &bob, &carol, &dave]).await;
    let commit = json!({ "amount": MIN.to_string() });
    let g_on_call_first = e.ok(&alice, "go_on_call", commit.clone(), 1).await.total_gas_burnt;
    let g_on_call_top_up = e.ok(&alice, "go_on_call", commit.clone(), 1).await.total_gas_burnt;
    e.on_call(&bob, BAG).await;
    e.on_call(&carol, MIN).await;
    e.on_call(&dave, MIN).await;
    let g_clock_out_idle = e.ok(&dave, "clock_out", json!({}), 1).await.total_gas_burnt;
    let deadline = e.now().await + 120_000;
    join_all((1..=5).map(|r| {
        let e = &e;
        async move {
            for i in 0..10 {
                let cve = format!("CVE-2026-5{r}{i:03}");
                let res = e.ok(&id(&format!("r{r}")), "report_ticket", Env::report(&cve, deadline, false), 0).await;
                assert_eq!(res.json::<Value>().unwrap()["activated"], true);
            }
        }
    }))
    .await;
    let open: Vec<Value> = e.view("get_open_tickets", json!({})).await;
    assert_eq!(open.len(), 50);
    let first = open[0]["id"].as_u64().unwrap() as u32;
    let g_close = e.close(&alice, first, "fixed").await.total_gas_burnt;
    let g_close_again = e.close(&alice, first, "mitigated").await.total_gas_burnt;
    let g_transfer = e.transfer(&dave, &carol, KEV).await.total_gas_burnt;
    e.before(deadline).await;
    e.wait_until(deadline).await;
    let r = e.ok(&id("r1"), "poke", json!({}), 0).await;
    assert_eq!(r.clone().json::<u32>().unwrap(), 50);
    let g_poke = r.total_gas_burnt;
    let r = e.ok(&id("r1"), "settle", json!({ "account_id": bob, "limit": 50 }), 0).await;
    let s = r.clone().json::<Value>().unwrap();
    assert_eq!((s["settled"].clone(), s["remaining"].clone()), (json!(50), json!(0)));
    let g_settle = r.total_gas_burnt;
    let mut b = BAG;
    for _ in 0..50 {
        b -= b / 100;
    }
    assert_eq!(e.bal(&bob).await, b);
    let r = e.ok(&carol, "clock_out", json!({}), 1).await;
    let g_clock_out_settling = r.total_gas_burnt;
    let d = r.json::<Value>().unwrap();
    assert_eq!(
        (d["missed"].clone(), d["unsettled"].clone(), d["on_call"].clone()),
        (json!(50), json!(0), json!(false))
    );

    // second wave: alice answers all 50 in one batch, plus one ticket that stays open longer
    e.settle(&alice).await;
    let deadline = e.now().await + LEAD;
    join_all((1..=5).map(|r| {
        let e = &e;
        async move {
            for i in 0..10 {
                let cve = format!("CVE-2026-7{r}{i:03}");
                let res = e.ok(&id(&format!("r{r}")), "report_ticket", Env::report(&cve, deadline, false), 0).await;
                assert_eq!(res.json::<Value>().unwrap()["activated"], true);
            }
        }
    }))
    .await;
    let later = e
        .ok(&id("r1"), "report_ticket", Env::report("CVE-2026-79999", deadline + LEAD, false), 0)
        .await
        .json::<Value>()
        .unwrap()["ticket_id"]
        .as_u64()
        .unwrap() as u32;
    let wave: Vec<u32> = e
        .view::<Vec<Value>>("get_open_tickets", json!({}))
        .await
        .iter()
        .map(|t| t["id"].as_u64().unwrap() as u32)
        .filter(|id| *id != later)
        .collect();
    assert_eq!(wave.len(), 50);
    let answers =
        wave.iter().map(|id| fc("close_ticket", json!({ "ticket_id": id, "status": "fixed" }), 0, 5)).collect();
    let r = near_api::Transaction::construct(alice.clone(), e.kevin.clone())
        .add_actions(answers)
        .with_signer(e.signer.clone())
        .send_to(&e.net)
        .await
        .unwrap()
        .into_full()
        .unwrap();
    assert!(r.into_result().is_ok(), "the batch of 50 answers should succeed");
    e.before(deadline).await;
    e.wait_until(deadline).await;
    let g_transfer_due = e.transfer(&dave, &carol, KEV).await.total_gas_burnt;
    let s: Value = e.view("get_stats", json!({})).await;
    assert_eq!(s["tickets_open"], 1, "views read the clock");
    let r = e.close(&alice, later, "fixed").await;
    assert!(has_event(&r, "kevin", "ticket_expired"), "the answer expired the due tickets");
    let g_close_due = r.total_gas_burnt;
    assert_eq!(e.ok(&id("r1"), "poke", json!({}), 0).await.json::<u32>().unwrap(), 0);
    let d = e.desk(&alice).await;
    assert_eq!((d["unsettled"].clone(), d["on_time"].clone()), (json!(0), json!(52)));
    let rows = [
        ("go_on_call (first time, joins the roster)", g_on_call_first),
        ("go_on_call (top-up)", g_on_call_top_up),
        ("close_ticket (first statement)", g_close),
        ("close_ticket (replacing a statement)", g_close_again),
        ("ft_transfer (free balance)", g_transfer),
        ("ft_transfer (50 tickets due, not poked: expires nothing)", g_transfer_due),
        ("close_ticket (50 tickets due, not poked: expires them, walks 50 answered)", g_close_due),
        ("clock_out (nothing due, no open tickets)", g_clock_out_idle),
        ("clock_out (settles 50 missed entries inside)", g_clock_out_settling),
        ("poke (expires 50 tickets)", g_poke),
        ("settle (50 missed tickets)", g_settle),
    ];
    for (name, g) in rows {
        println!("GAS {name}: {:.2} Tgas", tgas(g));
        assert!(g < NearGas::from_tgas(300));
    }
}
