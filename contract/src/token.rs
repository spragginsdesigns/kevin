// NEP-141 and NEP-148 on top of the desks. Transfers move the free balance only and settle
// nobody: committed tokens cannot move, so there is no burn to dodge by moving tokens.
use crate::events;
use crate::{Contract, ContractExt};
use near_contract_standards::fungible_token::core::FungibleTokenCore;
use near_contract_standards::fungible_token::metadata::{
    FT_METADATA_SPEC, FungibleTokenMetadata, FungibleTokenMetadataProvider,
};
use near_contract_standards::fungible_token::receiver::ext_ft_receiver;
use near_contract_standards::fungible_token::resolver::{FungibleTokenResolver, ext_ft_resolver};
use near_sdk::json_types::U128;
use near_sdk::{AccountId, Gas, PromiseOrValue, assert_one_yocto, env, near, require, serde_json};

/// The resolver only moves free balances and runs no expiry, so its cost does not depend on how
/// many tickets are due; 10 Tgas leaves a margin over the standard 5.
const GAS_FOR_RESOLVE_TRANSFER: Gas = Gas::from_tgas(10);

pub const NAME: &str = "Kevin from IT";
pub const SYMBOL: &str = "KEVIN";
pub const DECIMALS: u8 = 18;
const ICON: &str = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect x='3' y='7' width='26' height='18' rx='2' fill='%23f4efe4' stroke='%23111' stroke-width='2'/%3E%3Cpath d='M21 7v18' stroke='%23111' stroke-width='2' stroke-dasharray='2 2'/%3E%3Ctext x='12' y='20' font-family='monospace' font-size='9' font-weight='700' text-anchor='middle' fill='%23111'%3EK%3C/text%3E%3C/svg%3E";

impl Contract {
    fn require_holder(&self, account: &AccountId) {
        if !self.is_holder(account) {
            env::panic_str(&format!("The account {account} is not registered"));
        }
    }

    pub(crate) fn internal_transfer(
        &mut self,
        sender: &AccountId,
        receiver: &AccountId,
        amount: u128,
        memo: Option<&str>,
    ) {
        require!(sender != receiver, "Sender and receiver should be different");
        require!(amount > 0, "The amount should be a positive number");
        self.require_holder(sender);
        self.require_holder(receiver);
        let from = self.stored_balance(sender);
        if from < amount {
            let committed = if Self::is_pool(sender) { 0 } else { self.desks.get(sender).map_or(0, |d| d.committed) };
            if amount <= from.saturating_add(committed) {
                env::panic_str("not enough free balance: committed tokens cannot move");
            }
            env::panic_str("The account doesn't have enough balance");
        }
        self.set_balance(sender, from - amount);
        let to = self.stored_balance(receiver);
        self.set_balance(receiver, to.checked_add(amount).unwrap_or_else(|| env::panic_str("Balance overflow")));
        events::ft_transfer(sender, receiver, amount, memo);
    }
}

#[near]
impl FungibleTokenCore for Contract {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        assert_one_yocto();
        // token moves touch only free balances and never run expiry, so a flood of due tickets
        // cannot make a transfer run out of gas
        events::reset();
        let sender = env::predecessor_account_id();
        self.internal_transfer(&sender, &receiver_id, amount.0, memo.as_deref());
    }

    #[payable]
    fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128> {
        assert_one_yocto();
        events::reset();
        let sender = env::predecessor_account_id();
        self.internal_transfer(&sender, &receiver_id, amount.0, memo.as_deref());
        ext_ft_receiver::ext(receiver_id.clone())
            .with_unused_gas_weight(1)
            .ft_on_transfer(sender.clone(), amount, msg)
            .then(
                ext_ft_resolver::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_RESOLVE_TRANSFER)
                    .with_unused_gas_weight(0)
                    .ft_resolve_transfer(sender, receiver_id, amount),
            )
            .into()
    }

    fn ft_total_supply(&self) -> U128 {
        U128(self.total_supply)
    }

    /// The whole bag: the free balance plus what stays committed after settling everything due
    /// now.
    fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        if Self::is_pool(&account_id) {
            return U128(self.pool);
        }
        U128(
            self.desks.get(&account_id).map_or(0, |d| d.balance + self.project(d, env::block_timestamp_ms()).committed),
        )
    }
}

#[near]
impl FungibleTokenResolver for Contract {
    /// Never panics: a failed resolver would strand the refund. It refunds against the
    /// receiver's free balance, like the standard implementation.
    #[private]
    fn ft_resolve_transfer(&mut self, sender_id: AccountId, receiver_id: AccountId, amount: U128) -> U128 {
        events::reset();
        const MAX_RESULT_LENGTH: usize = "\"+340282366920938463463374607431768211455\"".len();
        let unused = env::promise_result_checked(0, MAX_RESULT_LENGTH)
            .ok()
            .and_then(|v| serde_json::from_slice::<U128>(&v).ok())
            .unwrap_or(amount)
            .0
            .min(amount.0);
        if unused == 0 {
            return amount;
        }
        let receiver_balance = if self.is_holder(&receiver_id) { self.stored_balance(&receiver_id) } else { 0 };
        if receiver_balance == 0 {
            return amount;
        }
        let refund = receiver_balance.min(unused);
        self.set_balance(&receiver_id, receiver_balance - refund);
        if self.is_holder(&sender_id) {
            let sender_balance = self.stored_balance(&sender_id);
            self.set_balance(&sender_id, sender_balance + refund);
            events::ft_transfer(&receiver_id, &sender_id, refund, Some("refund"));
            U128(amount.0 - refund)
        } else {
            // unreachable while desks are permanent; kept so a missing sender burns instead of panicking
            self.total_supply -= refund;
            events::emit(events::NEP141, "ft_burn", &[events::ft_burn_item(&receiver_id, refund, "refund")]);
            amount
        }
    }
}

#[near]
impl FungibleTokenMetadataProvider for Contract {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        FungibleTokenMetadata {
            spec: FT_METADATA_SPEC.to_string(),
            name: NAME.to_string(),
            symbol: SYMBOL.to_string(),
            icon: Some(ICON.to_string()),
            reference: None,
            reference_hash: None,
            decimals: DECIMALS,
        }
    }
}

#[near]
impl Contract {
    /// Once per account id, a fixed bag from the desk pool into the free balance. This is the
    /// only way tokens leave the pool, so anything sent to the contract account stays there.
    pub fn claim_starter(&mut self) -> U128 {
        self.run_expiry();
        let who = env::predecessor_account_id();
        if !self.desks.contains_key(&who) {
            env::panic_str("register first: storage_deposit");
        }
        require!(!self.claimed.contains(&who), "starter already claimed");
        let bag = self.starter_bag;
        require!(self.pool > 0 && self.pool >= bag, "desk pool is empty");
        self.pool -= bag;
        let balance = self.stored_balance(&who);
        self.set_balance(&who, balance + bag);
        self.claimed.insert(who.clone());
        if bag > 0 {
            events::ft_transfer(&env::current_account_id(), &who, bag, Some("starter bag"));
        }
        U128(bag)
    }
}
