// The On-Call Program. Holding KEVIN asks nothing; a desk that goes on call moves part of its
// free balance into `committed`, which cannot be transferred and is what misses burn. It is
// liable for every ticket that expires while it is on call, and it can only clock out with every
// open ticket answered and only once its shift (`min_shift_ms`) is over, so nobody leaves to
// dodge a deadline or drops in only for the tickets it feels like answering.
use crate::{Contract, ContractExt, Desk, events};
use near_sdk::json_types::U128;
use near_sdk::{assert_one_yocto, env, near, require};

#[near]
impl Contract {
    /// Commits `amount` of the free balance. The first call (at least `min_commit`) puts the
    /// desk on call, liable only for tickets that expire from now on; later calls top it up
    /// after settling what is already due at the old amount. Needs 1 yoctoNEAR, so only a
    /// full-access key can commit tokens.
    #[payable]
    pub fn go_on_call(&mut self, amount: U128) -> Desk {
        assert_one_yocto();
        self.run_expiry();
        let who = env::predecessor_account_id();
        let Some(desk) = self.desks.get(&who) else {
            env::panic_str("register first: storage_deposit");
        };
        require!(amount.0 > 0, "amount must be positive");
        if desk.on_call {
            self.settle_or_panic(&who);
        } else {
            require!(amount.0 >= self.min_commit, "commit at least the minimum to go on call");
        }
        let now = env::block_timestamp_ms();
        let expired = self.expired.len();
        let desk = self.desks.get_mut(&who).expect("registered");
        require!(desk.balance >= amount.0, "not enough free balance");
        if !desk.on_call {
            desk.on_call = true;
            desk.on_call_since_ms = now;
            // tickets already open count, tickets already expired do not
            desk.cursor = expired;
            if desk.first_on_call_ms == 0 {
                desk.first_on_call_ms = now;
                self.roster.push(who.clone());
            }
            self.on_call_desks += 1;
        }
        desk.balance -= amount.0;
        desk.committed += amount.0;
        self.committed_total += amount.0;
        events::on_call(&who, amount.0, desk.committed);
        self.get_desk(who)
    }

    /// Returns everything committed to the free balance. The desk must be settled, its shift
    /// must be over and it must have answered every ticket that is open now. Needs 1 yoctoNEAR,
    /// so only a full-access key can clock a desk out.
    #[payable]
    pub fn clock_out(&mut self) -> Desk {
        assert_one_yocto();
        self.run_expiry();
        let who = env::predecessor_account_id();
        if !self.desks.get(&who).is_some_and(|d| d.on_call) {
            env::panic_str("not on call");
        }
        self.settle_or_panic(&who);
        let desk = self.desks.get_mut(&who).expect("on call");
        if env::block_timestamp_ms() < desk.on_call_since_ms.saturating_add(self.min_shift_ms) {
            env::panic_str("your shift is not over");
        }
        // expiry just ran, so every ticket in `open` is open now
        for (ticket_id, _) in &self.open {
            if !self.statements.contains_key(&(desk.idx, *ticket_id)) {
                env::panic_str("answer every open ticket before you clock out");
            }
        }
        let returned = desk.committed;
        desk.balance += returned;
        desk.committed = 0;
        desk.on_call = false;
        self.on_call_desks -= 1;
        self.committed_total -= returned;
        events::clocked_out(&who, returned);
        self.get_desk(who)
    }
}
