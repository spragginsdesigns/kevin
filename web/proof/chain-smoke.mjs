// Exercises the web app's real-chain adapter (web/src/chain.js) against NEAR testnet from Node:
// faucet account creation, a two-action signed transaction, a function-call call, and adding the
// close_ticket-only on-call key, then reads the key back to check its permission.
// The KEVIN contract may not be deployed yet, so TARGET defaults to wrap.testnet (a NEP-141/145
// contract): storage_deposit + claim_starter is expected to fail on claim_starter there, which still
// proves the transaction is signed, sent and its failure parsed. Never prints secret keys.
// Usage: node web/proof/chain-smoke.mjs   (env: TARGET, default wrap.testnet)
import { JsonRpcProvider } from 'near-api-js';

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};

const { createChain } = await import('../src/chain.js');
const { explainError } = await import('../src/errors.js');
const TARGET = process.env.TARGET || 'wrap.testnet';
const chain = createChain({ contractId: TARGET, deskKey: 'live' });
const out = (k, v) => console.log(`${k}: ${typeof v === 'string' ? v : JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x))}`);

const steps = [];
const guest = await chain.createGuest((s) => steps.push(s));
out('faucet steps', steps.join(' -> '));
out('guest account', guest.accountId);

const rpc = new JsonRpcProvider({ url: 'https://test.rpc.fastnear.com' });
const acct = await rpc.viewAccount({ accountId: guest.accountId });
out('guest balance (yoctoNEAR)', acct.amount);

try {
  const r = await chain.register();
  out('register (storage_deposit + claim_starter)', { ok: true, ...r });
} catch (e) {
  out('register (storage_deposit + claim_starter) failed as expected on a non-KEVIN contract', `${e.constructor.name}: ${String(e.message).slice(0, 160)}`);
  out('  explained to the user as', explainError(e));
}

try {
  await chain.closeTicket(0, 'fixed');
  out('close_ticket', 'unexpectedly succeeded');
} catch (e) {
  out('close_ticket failed as expected on a non-KEVIN contract', `${e.constructor.name}: ${String(e.message).slice(0, 160)}`);
}

const key = await chain.addOncallKey();
out('add on-call key tx', key.txHash);
const ak = await rpc.viewAccessKey({ accountId: guest.accountId, publicKey: key.publicKey });
out('on-call key permission read back', ak.permission);
