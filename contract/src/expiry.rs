use crate::events::{self, KEVIN};
use crate::{Contract, ContractExt, TicketState};
use near_sdk::{env, near};

impl Contract {
    /// Open tickets whose deadline has passed, in the order expiry appends them to `expired`
    /// (deadline, then id). Views use the same order to predict burns before anyone pokes.
    pub(crate) fn due(&self, now: u64) -> Vec<u32> {
        let mut due: Vec<(u64, u32)> =
            self.open.iter().filter(|(_, deadline)| now >= *deadline).map(|(id, deadline)| (*deadline, *id)).collect();
        due.sort_unstable();
        due.into_iter().map(|(_, id)| id).collect()
    }

    /// Runs first in every change method, so no call ever sees a ticket that is past its deadline
    /// but still open. Returns how many tickets expired.
    pub(crate) fn run_expiry(&mut self) -> u32 {
        events::reset();
        let now = env::block_timestamp_ms();
        let due = self.due(now);
        if due.is_empty() {
            return 0;
        }
        self.open.retain(|(_, deadline)| now < *deadline);
        let mut items = Vec::with_capacity(due.len());
        for &id in &due {
            let ticket = self.tickets.get_mut(id).expect("open ticket exists");
            ticket.state = TicketState::Expired;
            events::touch();
            items.push(events::ticket_expired_item(id, &ticket.cve_id));
            self.expired.push(id);
        }
        events::emit(KEVIN, "ticket_expired", &items);
        due.len() as u32
    }
}

#[near]
impl Contract {
    /// Permissionless: expires every open ticket whose deadline has passed.
    pub fn poke(&mut self) -> u32 {
        self.run_expiry()
    }
}
