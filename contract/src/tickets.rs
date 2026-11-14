// Reporters open tickets by quorum; desks on call answer them. The burn rate comes from the
// config, never from the report, so a reporter can choose which bug is on the board but not its
// price.
use crate::events;
use crate::month::{count_month, month_of};
use crate::{
    Contract, ContractExt, DAY_MS, MAX_WINDOW_MS, Pending, ReportResult, Statement, Status, Ticket, TicketReport,
    TicketState,
};
use near_sdk::json_types::{U64, U128};
use near_sdk::{AccountId, borsh, env, near, require};

const MAX_CVE_LEN: usize = 24;
const MAX_NAME_LEN: usize = 80;
const DATE_LEN: usize = 10;

/// `CVE-YYYY-N+`, at most 24 bytes.
pub fn valid_cve(cve: &str) -> bool {
    let b = cve.as_bytes();
    b.len() >= 10
        && b.len() <= MAX_CVE_LEN
        && b.starts_with(b"CVE-")
        && b[4..8].iter().all(u8::is_ascii_digit)
        && b[8] == b'-'
        && b[9..].iter().all(u8::is_ascii_digit)
}

fn validate(report: &TicketReport) {
    require!(valid_cve(&report.cve_id), "bad cve id");
    require!(
        report.vendor.len() <= MAX_NAME_LEN
            && report.product.len() <= MAX_NAME_LEN
            && report.date_added.len() == DATE_LEN
            && report.due_date.len() == DATE_LEN,
        "field too long"
    );
}

fn count_mut(ticket: &mut Ticket, status: Status) -> &mut u32 {
    match status {
        Status::NotAffected => &mut ticket.not_affected,
        Status::Fixed => &mut ticket.fixed,
        Status::Mitigated => &mut ticket.mitigated,
    }
}

impl Contract {
    /// A pending report can never activate once its CVE is on the board or its deadline is
    /// inside the minimum window.
    fn pending_is_live(&self, report: &TicketReport, now: u64) -> bool {
        !self.by_cve.contains_key(&report.cve_id) && report.deadline_ms.0 >= now.saturating_add(self.min_window_ms)
    }

    /// Records that `reporter` holds a confirmation on `hash`, after dropping its dead entries.
    /// Caps a reporter at `max_open` live pending reports, so a lone rogue reporter cannot grow
    /// the contract's storage without bound.
    fn track_pending(&mut self, reporter: &AccountId, hash: [u8; 32], now: u64) {
        let mut list = self.reporter_pending.get(reporter).cloned().unwrap_or_default();
        let mut dead = Vec::new();
        list.retain(|h| match self.pending.get(h) {
            Some(p) if self.pending_is_live(&p.report, now) => true,
            Some(_) => {
                dead.push(*h);
                false
            }
            None => false,
        });
        for h in dead {
            self.pending.remove(&h);
        }
        require!(list.len() < self.max_open as usize, "too many pending reports");
        list.push(hash);
        self.reporter_pending.insert(reporter.clone(), list);
    }

    fn open_ticket(&mut self, report: TicketReport, now: u64) -> u32 {
        let id = self.tickets.len();
        let burn_bps = if report.ransomware { self.ransom_miss_bps } else { self.miss_bps };
        let deadline = report.deadline_ms.0;
        events::ticket_opened(id, &report.cve_id, deadline, burn_bps);
        self.by_cve.insert(report.cve_id.clone(), id);
        self.open.push((id, deadline));
        self.tickets.push(Ticket {
            id,
            cve_id: report.cve_id,
            vendor: report.vendor,
            product: report.product,
            date_added: report.date_added,
            due_date: report.due_date,
            ransomware: report.ransomware,
            opened_at_ms: U64(now),
            deadline_ms: U64(deadline),
            burn_bps,
            state: TicketState::Open,
            closes: 0,
            not_affected: 0,
            fixed: 0,
            mitigated: 0,
            missed: 0,
            burned: U128(0),
        });
        id
    }
}

#[near]
impl Contract {
    /// One confirmation per reporter per report; the report (identified by the sha256 of its
    /// borsh bytes) opens a ticket when confirmations reach the quorum.
    pub fn report_ticket(&mut self, report: TicketReport) -> ReportResult {
        self.run_expiry();
        let who = env::predecessor_account_id();
        require!(self.reporters.contains(&who), "not a reporter");
        validate(&report);
        require!(!self.by_cve.contains_key(&report.cve_id), "ticket exists");
        let now = env::block_timestamp_ms();
        require!(report.deadline_ms.0 >= now.saturating_add(self.min_window_ms), "window too short");
        // a far-future junk ticket would hold an `open` slot for good
        require!(report.deadline_ms.0 <= now.saturating_add(MAX_WINDOW_MS), "window too long");

        let hash = env::sha256_array(borsh::to_vec(&report).expect("borsh"));
        let mut pending = self.pending.remove(&hash).unwrap_or(Pending { report, confirmers: Vec::new() });
        require!(!pending.confirmers.contains(&who), "already confirmed");
        pending.confirmers.push(who.clone());
        let confirmations = pending.confirmers.len() as u8;
        if confirmations >= self.quorum {
            require!(self.open.len() < self.max_open as usize, "too many open tickets");
            let day = now / DAY_MS;
            if day != self.day_index {
                self.day_index = day;
                self.opened_today = 0;
            }
            require!(self.opened_today < self.max_open, "too many tickets today");
            self.opened_today += 1;
            let id = self.open_ticket(pending.report, now);
            return ReportResult { activated: true, ticket_id: Some(id), confirmations };
        }
        self.track_pending(&who, hash, now);
        self.pending.insert(hash, pending);
        ReportResult { activated: false, ticket_id: None, confirmations }
    }

    /// The first statement on a ticket is what counts for the record; later ones before the
    /// deadline only change the status. Only a desk on call answers, so nobody builds a record
    /// without a stake.
    pub fn close_ticket(&mut self, ticket_id: u32, status: Status) -> Statement {
        self.run_expiry();
        let who = env::predecessor_account_id();
        let Some(desk) = self.desks.get(&who) else {
            env::panic_str("register first: storage_deposit");
        };
        if !desk.on_call {
            env::panic_str("go on call first: go_on_call");
        }
        // a miss that is already due resets the streak before this answer counts, not after; a
        // desk that cannot be fully settled here does not get to answer across its misses
        self.settle_or_panic(&who);
        let desk = self.desks.get_mut(&who).expect("registered");
        let Some(ticket) = self.tickets.get_mut(ticket_id) else {
            env::panic_str("no such ticket");
        };
        let now = env::block_timestamp_ms();
        require!(ticket.state == TicketState::Open && now < ticket.deadline_ms.0, "deadline passed");
        let statement = Statement { status, at_ms: U64(now) };
        match self.statements.insert((desk.idx, ticket_id), statement) {
            Some(old) => *count_mut(ticket, old.status) -= 1,
            None => {
                ticket.closes += 1;
                desk.on_time += 1;
                desk.streak += 1;
                desk.best_streak = desk.best_streak.max(desk.streak);
                count_month(desk, month_of(now), 1, 0, 0);
                self.statements_total += 1;
            }
        }
        *count_mut(ticket, status) += 1;
        events::statement(&who, ticket_id, &ticket.cve_id, status, now);
        statement
    }
}
