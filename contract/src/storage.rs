// NEP-145. Registration opens a desk that is not on call and is liable for nothing; its cursor
// is set when it goes on call. Desks are never removed.
use crate::{Contract, ContractExt, DeskRecord};
use near_contract_standards::storage_management::{StorageBalance, StorageBalanceBounds, StorageManagement};
use near_sdk::{AccountId, NearToken, Promise, assert_one_yocto, env, log, near};

impl Contract {
    fn registration_cost(&self) -> NearToken {
        env::storage_byte_cost().saturating_mul(self.registration_bytes as u128)
    }

    fn storage_balance(&self, account: &AccountId) -> Option<StorageBalance> {
        self.is_holder(account)
            .then(|| StorageBalance { total: self.registration_cost(), available: NearToken::from_yoctonear(0) })
    }
}

#[near]
impl StorageManagement for Contract {
    /// `registration_only` changes nothing: the minimum and maximum balance are the same.
    #[payable]
    #[allow(unused_variables)]
    fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>) -> StorageBalance {
        self.run_expiry();
        let amount = env::attached_deposit();
        let account = account_id.unwrap_or_else(env::predecessor_account_id);
        if self.is_holder(&account) {
            log!("The account is already registered, refunding the deposit");
            if !amount.is_zero() {
                Promise::new(env::predecessor_account_id()).transfer(amount).detach();
            }
        } else {
            let min = self.registration_cost();
            if amount < min {
                env::panic_str("The attached deposit is less than the minimum storage balance");
            }
            let desk = DeskRecord {
                idx: self.next_desk_idx,
                registered_at_ms: env::block_timestamp_ms(),
                ..DeskRecord::default()
            };
            self.next_desk_idx += 1;
            self.accounts += 1;
            self.desks.insert(account.clone(), desk);
            let refund = amount.saturating_sub(min);
            if !refund.is_zero() {
                Promise::new(env::predecessor_account_id()).transfer(refund).detach();
            }
        }
        self.storage_balance(&account).expect("registered")
    }

    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        assert_one_yocto();
        let who = env::predecessor_account_id();
        let Some(balance) = self.storage_balance(&who) else {
            env::panic_str(&format!("The account {who} is not registered"));
        };
        if amount.is_some_and(|a| !a.is_zero()) {
            env::panic_str("The amount is greater than the available storage balance");
        }
        balance
    }

    /// Desks are permanent: unregistering and registering again would hand the account a
    /// fresh record and orphan the statements its old one made.
    #[payable]
    #[allow(unused_variables)]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        assert_one_yocto();
        let who = env::predecessor_account_id();
        if !self.desks.contains_key(&who) {
            log!("The account {} is not registered", who);
            return false;
        }
        env::panic_str("desks are permanent");
    }

    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        let cost = self.registration_cost();
        StorageBalanceBounds { min: cost, max: Some(cost) }
    }

    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.storage_balance(&account_id)
    }
}
