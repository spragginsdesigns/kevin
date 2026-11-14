// The only module that talks to NEAR. Every script goes through it, so a detail of the chain interface
// (a method name, gas, an RPC quirk) lives in one place. Written against
// near-api-js 7.5.3: Provider.callFunction({contractId, method, args}) for views,
// Account.callFunctionRaw({contractId, methodName, args, gas, deposit}) for calls,
// Account.createTransaction({receiverId, actions, publicKey}) for dry runs.

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  Account,
  JsonRpcProvider,
  KeyPair,
  KeyPairSigner,
  PublicKey,
  actions,
  getTransactionLastResult,
  teraToGas,
} from 'near-api-js';

export const RPC_URLS = Object.freeze({
  testnet: ['https://test.rpc.fastnear.com', 'https://near-testnet.drpc.org'],
  mainnet: ['https://free.rpc.fastnear.com', 'https://rpc.mainnet.near.org'],
});
// v2 (the On-Call Program). The v1 desks coin.kevin-it.testnet and drill.kevin-it.testnet stay up as the earlier
// version; the v2 fire drill is firedrill.kevin-it.testnet.
export const DEFAULT_CONTRACT = 'pager.kevin-it.testnet';
export const DRILL_CONTRACT = 'firedrill.kevin-it.testnet';
// get_roster caps a page at 50; the scripts read 25 per call.
export const ROSTER_PAGE = 25;
// get_roster_accounts caps a page at 100.
export const ROSTER_ACCOUNTS_PAGE = 100;
export const EXPLORER_TX = Object.freeze({
  testnet: 'https://testnet.nearblocks.io/txns/',
  mainnet: 'https://nearblocks.io/txns/',
});

/** Network, contract and RPC list from the environment (KEVIN_NETWORK, KEVIN_CONTRACT, KEVIN_RPC comma list). */
export function chainSettings(env = process.env) {
  const network = env.KEVIN_NETWORK || 'testnet';
  if (!RPC_URLS[network]) throw new Error(`unknown network ${network}`);
  const rpcs = (env.KEVIN_RPC || '').split(',').map((s) => s.trim()).filter(Boolean);
  return { network, contractId: env.KEVIN_CONTRACT || DEFAULT_CONTRACT, rpcs: rpcs.length ? rpcs : RPC_URLS[network] };
}

// near-api-js's FailoverRpcProvider also fails over on contract errors and console.errors each one,
// which buries the real panic text. So pick the first RPC that answers once, then use it directly.
async function pickProvider(rpcs) {
  const failures = [];
  for (const url of rpcs) {
    const provider = new JsonRpcProvider({ url }, { retries: 3, wait: 400, backoff: 2 });
    try {
      await provider.viewBlock({ finality: 'final' });
      return provider;
    } catch (err) {
      failures.push(`${url}: ${String(err?.message ?? err).split('\n')[0]}`);
    }
  }
  throw new Error(`no RPC reachable (${failures.join('; ')})`);
}

/** Root of the near-cli legacy keychain; NEAR_CREDENTIALS_DIR overrides ~/.near-credentials. */
export function credentialsRoot(env = process.env) {
  return env.NEAR_CREDENTIALS_DIR || join(homedir(), '.near-credentials');
}

/** A signing credential. The secret stays inside the KeyPair and is never part of anything we print. */
export function credentialFromSecret(accountId, secret, source = 'secret') {
  const keyPair = KeyPair.fromString(secret);
  const cred = { accountId, publicKey: keyPair.getPublicKey().toString(), source };
  // Non-enumerable so console.log(cred) or JSON.stringify(cred) can never print the secret key.
  Object.defineProperty(cred, 'keyPair', { value: keyPair, enumerable: false });
  return cred;
}

/**
 * Load `<root>/<network>/<account>.json` (or `<root>/<account>.json` when NEAR_CREDENTIALS_DIR points
 * straight at a network folder). Shape: { account_id, public_key, private_key }.
 */
export async function loadCredential(accountId, { network = 'testnet', env = process.env } = {}) {
  const root = credentialsRoot(env);
  const paths = [join(root, network, `${accountId}.json`), join(root, `${accountId}.json`)];
  for (const path of paths) {
    let text;
    try {
      text = await readFile(path, 'utf8');
    } catch {
      continue;
    }
    const json = JSON.parse(text);
    const secret = json.private_key ?? json.secret_key;
    if (!secret) throw new Error(`${path}: no private_key`);
    if (json.account_id && json.account_id !== accountId) throw new Error(`${path}: account_id is ${json.account_id}`);
    const cred = credentialFromSecret(accountId, secret, path);
    if (json.public_key && json.public_key !== cred.publicKey) throw new Error(`${path}: public_key does not match private_key`);
    return cred;
  }
  throw new Error(`no key for ${accountId} in ${paths.join(' or ')}`);
}

/** Does an access-key permission (RPC view shape) allow calling `methodName` on `contractId`? */
export function permissionAllows(permission, contractId, methodName) {
  if (permission === 'FullAccess') return { ok: true, kind: 'full access' };
  const fc = permission?.FunctionCall;
  if (!fc) return { ok: false, kind: JSON.stringify(permission) };
  const methods = fc.method_names ?? [];
  const ok = fc.receiver_id === contractId && (methods.length === 0 || methods.includes(methodName));
  const kind = `function-call key for ${fc.receiver_id} [${methods.join(', ') || 'any method'}]`;
  return { ok, kind };
}

export class KevinChain {
  constructor({ network, contractId, rpcs } = chainSettings()) {
    this.network = network;
    this.contractId = contractId;
    this.rpcs = rpcs;
    this.providerPromise = null;
  }

  provider() {
    this.providerPromise ??= pickProvider(this.rpcs);
    return this.providerPromise;
  }

  async view(method, args = {}) {
    return (await this.provider()).callFunction({ contractId: this.contractId, method, args });
  }

  getConfig() { return this.view('get_config'); }
  getStats() { return this.view('get_stats'); }
  getTicketByCve(cveId) { return this.view('get_ticket_by_cve', { cve_id: cveId }); }
  getOpenTickets() { return this.view('get_open_tickets'); }
  getDesk(accountId) { return this.view('get_desk', { account_id: accountId }); }
  getRoster(fromIndex, limit = ROSTER_PAGE) { return this.view('get_roster', { from_index: fromIndex, limit }); }

  getRosterAccounts(fromIndex, limit = ROSTER_ACCOUNTS_PAGE) {
    return this.view('get_roster_accounts', { from_index: fromIndex, limit });
  }

  /** Every account that was ever on call, in roster order. No desk is projected, so this stays cheap however
   * far behind any desk is; the janitor uses it to find desks to settle. */
  async getRosterAccountIds(pageSize = ROSTER_ACCOUNTS_PAGE) {
    const all = [];
    for (;;) {
      const page = (await this.getRosterAccounts(all.length, pageSize)) ?? [];
      all.push(...page);
      if (page.length < pageSize) return all;
    }
  }

  /** Every desk that was ever on call, in roster order, paging get_roster. get_roster projects each desk's
   * pending burns, which costs more the further behind a desk is; a page that fails is read again in halves,
   * and a single desk that still cannot be read comes back as { account_id, desk: null }. */
  async getWholeRoster(pageSize = ROSTER_PAGE) {
    const total = Number((await this.getStats()).roster ?? 0);
    const read = async (from, count) => {
      if (count <= 0) return [];
      try {
        return (await this.getRoster(from, count)) ?? [];
      } catch (err) {
        if (count === 1) {
          const [accountId] = (await this.getRosterAccounts(from, 1)) ?? [];
          return accountId ? [{ account_id: accountId, desk: null }] : [];
        }
        const half = Math.ceil(count / 2);
        return [...(await read(from, half)), ...(await read(from + half, count - half))];
      }
    };
    const all = [];
    for (let from = 0; from < total; from += pageSize) all.push(...(await read(from, Math.min(pageSize, total - from))));
    return all;
  }

  /** Every ticket, paging get_tickets (capped at 100 per call by the contract). */
  async getAllTickets() {
    const all = [];
    for (;;) {
      const page = (await this.view('get_tickets', { from_index: all.length, limit: 100 })) ?? [];
      all.push(...page);
      if (page.length < 100) return all;
    }
  }

  /** get_statements in chunks, aligned with `ticketIds`. */
  async getStatements(accountId, ticketIds) {
    const out = [];
    for (let i = 0; i < ticketIds.length; i += 100) {
      const chunk = ticketIds.slice(i, i + 100);
      out.push(...((await this.view('get_statements', { account_id: accountId, ticket_ids: chunk })) ?? []));
    }
    return out;
  }

  async #account(cred) {
    return new Account(cred.accountId, await this.provider(), new KeyPairSigner(cred.keyPair));
  }

  /** The access key the credential signs with, and whether it may call `methodName` on the contract. */
  async checkKey(cred, methodName, receiverId = this.contractId) {
    const key = await (await this.provider()).viewAccessKey({
      accountId: cred.accountId,
      publicKey: PublicKey.from(cred.publicKey),
      finalityQuery: { finality: 'final' },
    });
    return { nonce: key.nonce, ...permissionAllows(key.permission, receiverId, methodName) };
  }

  /**
   * Dry run of a function call: checks the key on chain, then builds the exact unsigned transaction
   * (nonce and recent block hash from the RPC). Stops right before signing. Never touches the secret.
   */
  async prepareCall(cred, methodName, args, { gasTgas = 30, deposit = 0n } = {}) {
    const key = await this.checkKey(cred, methodName);
    const tx = await (await this.#account(cred)).createTransaction({
      receiverId: this.contractId,
      actions: [actions.functionCall(methodName, args, teraToGas(gasTgas), BigInt(deposit))],
      publicKey: cred.publicKey,
    });
    return {
      signer: cred.accountId,
      publicKey: cred.publicKey,
      key: key.kind,
      keyAllows: key.ok,
      receiverId: tx.receiverId,
      nonce: tx.nonce.toString(),
      methodName,
      args,
      gasTgas,
      deposit: BigInt(deposit).toString(),
    };
  }

  /** Sign and send one function call. Returns { result, txHash }. Throws with the contract's panic text. */
  async call(cred, methodName, args, { gasTgas = 30, deposit = 0n } = {}) {
    const outcome = await (await this.#account(cred)).callFunctionRaw({
      contractId: this.contractId,
      methodName,
      args,
      gas: teraToGas(gasTgas),
      deposit: BigInt(deposit),
    });
    return { result: getTransactionLastResult(outcome), txHash: outcome.transaction?.hash ?? outcome.transaction_outcome?.id };
  }

  /**
   * Add a FUNCTION-CALL access key to the credential's own account, limited to `methodNames` on the
   * contract. With dryRun, checks the signing key is full access and builds the unsigned transaction.
   */
  async addFunctionCallKey(cred, newPublicKey, { methodNames, allowanceYocto, dryRun }) {
    const key = await this.checkKey(cred, 'add_key', cred.accountId);
    if (key.kind !== 'full access') throw new Error(`${cred.accountId}: signing key is a ${key.kind}; adding a key needs a full-access key`);
    const action = actions.addFunctionCallAccessKey(PublicKey.from(newPublicKey), this.contractId, methodNames, BigInt(allowanceYocto));
    if (dryRun) {
      const tx = await (await this.#account(cred)).createTransaction({ receiverId: cred.accountId, actions: [action], publicKey: cred.publicKey });
      return { dryRun: true, signer: cred.accountId, nonce: tx.nonce.toString() };
    }
    const outcome = await (await this.#account(cred)).signAndSendTransaction({ receiverId: cred.accountId, actions: [action] });
    return { dryRun: false, txHash: outcome.transaction?.hash ?? outcome.transaction_outcome?.id };
  }

  explorerTx(hash) {
    return `${EXPLORER_TX[this.network]}${hash}`;
  }
}

