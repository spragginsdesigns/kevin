// Real NEAR testnet adapter. Every method name and argument shape follows the contract ABI:
// U64/U128 travel as decimal strings, u32 ids as numbers, Status as snake_case strings.
// near-api-js v7: JsonRpcProvider (with transport failover) for views, Account + KeyPairSigner for signing.
import {
  Account,
  JsonRpcProvider,
  KeyPair,
  KeyPairSigner,
  actions,
  getTransactionLastResult,
  teraToGas,
} from 'near-api-js';
import { FAUCET_URL, GUEST_SUFFIX, NETWORK_ID, RPC_URLS } from './config.js';
import { loadGuest, saveGuest, clearGuest, randomGuestId } from './guest.js';
import { isTransportError } from './errors.js';

const GAS = {
  storage: teraToGas(30),
  claim: teraToGas(60),
  close: teraToGas(60),
  settle: teraToGas(250),
  transfer: teraToGas(120),
  // go_on_call (a top-up settles first) and clock_out (settles, then checks the queue) can walk up to
  // the contract's settle limit, so they get the settle budget.
  oncall: teraToGas(250),
};
const ONE_YOCTO = 1n;
const ONCALL_ALLOWANCE = 250_000_000_000_000_000_000_000n; // 0.25 NEAR for gas, the near-api-js default

// One provider shared by every view and write. On a transport failure (network error, 429, 5xx) it
// backs off 1 s, 2 s, 4 s ... capped at 15 s and alternates endpoints. The backoff is shared, so a burst
// of pending calls waits together instead of each one hammering the next endpoint. Contract errors are
// never retried. (near-api-js's FailoverRpcProvider also fails over on contract errors and logs every
// attempt to the console.)
const ATTEMPTS = 3;
const backoffMs = (streak) => Math.min(15_000, 1000 * 2 ** Math.max(0, streak - 1));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class FailoverJsonRpc extends JsonRpcProvider {
  constructor(urls) {
    super({ url: urls[0] }, { retries: 1, wait: 0, backoff: 1 }); // one HTTP attempt; retries are ours
    this.urls = urls;
    this.current = 0;
    this.streak = 0;
    this.blockedUntil = 0;
  }
  async sendJsonRpc(method, params) {
    let last;
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const wait = this.blockedUntil - Date.now();
      if (wait > 0) await sleep(wait);
      const i = this.current;
      this.connection.url = this.urls[i]; // read synchronously by the parent before its first await
      try {
        const r = await super.sendJsonRpc(method, params);
        this.streak = 0;
        return r;
      } catch (e) {
        last = e;
        if (!isTransportError(e)) throw e;
        this.streak += 1;
        this.blockedUntil = Date.now() + backoffMs(this.streak);
        this.current = (i + 1) % this.urls.length;
      }
    }
    throw last;
  }
}

let sharedProvider = null;
function provider() {
  sharedProvider ||= new FailoverJsonRpc(RPC_URLS);
  return sharedProvider;
}

export function createChain({ contractId, deskKey }) {
  const rpc = provider();
  let account = null;

  const view = (method, args = {}) => rpc.callFunction({ contractId, method, args });
  const txHashOf = (res) => res?.transaction_outcome?.id || res?.transaction?.hash || null;

  // Every write returns { value, txHash } so the UI can link the transaction on the explorer.
  async function call(methodName, args, gas, deposit = 0n) {
    const acct = signerAccount();
    const res = await acct.callFunctionRaw({ contractId, methodName, args, gas, deposit });
    return { value: getTransactionLastResult(res), txHash: txHashOf(res) };
  }

  function signerAccount() {
    const g = loadGuest(NETWORK_ID);
    if (!g?.created) throw Object.assign(new Error('Open a guest desk first.'), { code: 'no_desk' });
    if (!account || account.accountId !== g.accountId) {
      account = new Account(g.accountId, rpc, KeyPairSigner.fromSecretKey(g.secretKey));
    }
    return account;
  }

  // True when the saved guest key is an access key of its account.
  async function ownsAccount(g) {
    try {
      const { keys } = await rpc.viewAccessKeyList({ accountId: g.accountId });
      return (keys || []).some((k) => String(k.public_key ?? k.publicKey) === g.publicKey);
    } catch {
      return false;
    }
  }

  async function waitForAccount(accountId, tries = 20) {
    for (let i = 0; i < tries; i++) {
      try {
        await rpc.viewAccount({ accountId });
        return true;
      } catch {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    return false;
  }

  return {
    mock: false,
    deskKey,
    contractId,
    network: NETWORK_ID,
    now: () => Date.now(),

    // Views
    getStats: () => view('get_stats'),
    getConfig: () => view('get_config'),
    getOpenTickets: () => view('get_open_tickets'),
    getTickets: (fromIndex, limit) => view('get_tickets', { from_index: fromIndex, limit }),
    async getAllTickets() {
      const out = [];
      for (let from = 0; ; from += 100) {
        const page = (await view('get_tickets', { from_index: from, limit: 100 })) || [];
        out.push(...page);
        if (page.length < 100) break;
      }
      return out;
    },
    getDesk: (accountId) => view('get_desk', { account_id: accountId }),
    getRoster: (fromIndex, limit) => view('get_roster', { from_index: fromIndex, limit }),
    getStatement: (accountId, ticketId) => view('get_statement', { account_id: accountId, ticket_id: ticketId }),
    getStatements: (accountId, ticketIds) =>
      ticketIds.length ? view('get_statements', { account_id: accountId, ticket_ids: ticketIds }) : Promise.resolve([]),
    storageBounds: () => view('storage_balance_bounds'),
    ftBalanceOf: (accountId) => view('ft_balance_of', { account_id: accountId }),

    // Identity: one guest account per network, shared by every desk contract on it.
    guest: () => loadGuest(NETWORK_ID),
    forgetGuest: () => clearGuest(NETWORK_ID),

    // Create guest-<random>.testnet through the public faucet helper. The key is saved before the
    // request goes out so a lost response never strands a funded account without its key.
    async createGuest(onStep = () => {}) {
      let g = loadGuest(NETWORK_ID);
      if (!g || g.created) {
        const kp = KeyPair.fromRandom('ed25519');
        g = { accountId: randomGuestId(GUEST_SUFFIX), secretKey: kp.toString(), publicKey: kp.getPublicKey().toString(), created: false };
        saveGuest(NETWORK_ID, g);
      }
      onStep('faucet');
      let res;
      try {
        res = await fetch(FAUCET_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ newAccountId: g.accountId, newAccountPublicKey: g.publicKey }),
        });
      } catch {
        throw Object.assign(new Error('Could not reach the testnet faucet. Check your connection and try again.'), { code: 'faucet_down' });
      }
      if (res.status === 429) {
        throw Object.assign(new Error('The testnet faucet is rate limiting this network address. It allows about 10 new accounts per address every 10 hours.'), { code: 'rate_limit' });
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        if (/exist/i.test(body)) {
          // Either an earlier attempt did create the account and its response was lost, or someone else
          // owns the name. Our key on the account tells which: keep the guest in the first case, pick a
          // fresh name in the second.
          if (await ownsAccount(g)) {
            g = { ...g, created: true, createdAt: Date.now() };
            saveGuest(NETWORK_ID, g);
            account = null;
            return g;
          }
          clearGuest(NETWORK_ID);
        }
        throw Object.assign(new Error(`The testnet faucet refused the request (HTTP ${res.status}). Try again.`), { code: 'faucet_refused' });
      }
      const out = await res.json().catch(() => null);
      const failure = out?.status?.Failure || out?.final_execution_outcome?.status?.Failure;
      if (failure) {
        clearGuest(NETWORK_ID);
        throw Object.assign(new Error('The faucet transaction failed on chain. Try again.'), { code: 'faucet_failed' });
      }
      onStep('confirm');
      const ok = await waitForAccount(g.accountId);
      if (!ok) throw Object.assign(new Error('The account was requested but is not visible on testnet yet. Try again in a moment.'), { code: 'not_visible' });
      g = { ...g, created: true, createdAt: Date.now(), faucetTx: txHashOf(out) || txHashOf(out?.final_execution_outcome) };
      saveGuest(NETWORK_ID, g);
      account = null;
      return g;
    },

    // ONE transaction, two actions: storage_deposit with the bounds' minimum, then claim_starter.
    async register(onStep = () => {}) {
      const acct = signerAccount();
      onStep('bounds');
      const bounds = await view('storage_balance_bounds');
      onStep('register');
      const res = await acct.signAndSendTransaction({
        receiverId: contractId,
        actions: [
          actions.functionCall('storage_deposit', { account_id: acct.accountId, registration_only: true }, GAS.storage, BigInt(bounds.min)),
          actions.functionCall('claim_starter', {}, GAS.claim, 0n),
        ],
      });
      return { value: null, txHash: txHashOf(res) };
    },

    // Take the pager (or add to the commitment) and give it back. Amounts are raw units as strings.
    // Both take exactly 1 yoctoNEAR, like ft_transfer: a function-call key can never attach a deposit, so
    // only a full-access key can commit tokens or clock a desk out.
    goOnCall: (amount) => call('go_on_call', { amount: amount.toString() }, GAS.oncall, ONE_YOCTO),
    clockOut: () => call('clock_out', {}, GAS.oncall, ONE_YOCTO),
    // close_ticket needs the caller on call and settles its due misses first, then files the statement.
    closeTicket: (ticketId, status) => call('close_ticket', { ticket_id: ticketId, status }, GAS.close),
    settle: (accountId) => call('settle', { account_id: accountId, limit: 50 }, GAS.settle),
    poke: () => call('poke', {}, GAS.settle),
    transfer: (receiverId, amount) =>
      call('ft_transfer', { receiver_id: receiverId, amount: amount.toString(), memo: null }, GAS.transfer, ONE_YOCTO),

    // FUNCTION-CALL access key limited to close_ticket on this contract. The secret is returned once
    // to the caller and never stored by the app.
    async addOncallKey() {
      const acct = signerAccount();
      const kp = KeyPair.fromRandom('ed25519');
      const publicKey = kp.getPublicKey().toString();
      const res = await acct.addFunctionCallAccessKey({
        publicKey,
        contractId,
        methodNames: ['close_ticket'],
        allowance: ONCALL_ALLOWANCE,
      });
      return { accountId: acct.accountId, contractId, publicKey, secretKey: kp.toString(), txHash: txHashOf(res) };
    },
  };
}
