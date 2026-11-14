#!/usr/bin/env node
// npm run janitor: permissionless upkeep. poke() expires tickets whose deadline passed, then settle()
// applies the pending burns for the listed accounts (and, with --roster, every on-call desk) so total supply
// reflects every missed deadline. Only on-call desks can owe anything; settling any other desk is a no-op.

import { readFile } from 'node:fs/promises';
import { errorText, parseCli, runMain, usage } from '../lib/cli.mjs';
import { KevinChain, chainSettings, loadCredential } from '../lib/chain.mjs';

const HELP = `
Usage: npm run janitor -- --signer <id> [account ...] [--roster] [options]

Calls poke(), then settle(account, limit) for each account until nothing is left to settle. Anyone can run
it: it moves no tokens of the signer. Accounts that are not on call or have nothing unsettled (get_desk) are
skipped. With --roster it also pages get_roster_accounts (100 per call) and settles every on-call desk whose
unsettled count is above 0.

The signer pays gas; its key comes from the near-cli keychain ($NEAR_CREDENTIALS_DIR, default
~/.near-credentials). Keys are never printed.

Environment: KEVIN_SIGNER (instead of --signer), KEVIN_CONTRACT, KEVIN_NETWORK, KEVIN_RPC, NEAR_CREDENTIALS_DIR.

Options:
  --signer <id>          account that signs and pays gas
  --accounts-file <path> more accounts: a JSON array or one id per line
  --roster               also settle every on-call desk on the roster that has unsettled tickets
  --limit <n>            entries per settle call, 1 to 200 (default 50)
  --gas-tgas <n>         gas per call in TGas (default 100)
  --no-poke              skip the poke() call
  --dry-run              read desks and build the unsigned poke/settle transactions; send nothing
  -h, --help             show this help

Exit codes: 0 ok, 1 a call failed, 2 bad arguments.
`;

async function readAccounts(path) {
  const text = await readFile(path, 'utf8');
  try {
    const json = JSON.parse(text);
    if (Array.isArray(json)) return json.map(String);
  } catch {
    // Not JSON: one account per line.
  }
  return text.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
}

runMain(async () => {
  const { values, positionals } = parseCli(
    HELP,
    {
      signer: { type: 'string' },
      'accounts-file': { type: 'string' },
      roster: { type: 'boolean' },
      limit: { type: 'string' },
      'gas-tgas': { type: 'string' },
      'no-poke': { type: 'boolean' },
      'dry-run': { type: 'boolean' },
    },
    { allowPositionals: true },
  );
  const signer = values.signer ?? process.env.KEVIN_SIGNER;
  if (!signer) usage('--signer (or KEVIN_SIGNER) is required');
  const limit = Number(values.limit ?? 50);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) usage('--limit must be an integer from 1 to 200');
  const gasTgas = Number(values['gas-tgas'] ?? 100);
  const named = [...new Set([...positionals, ...(values['accounts-file'] ? await readAccounts(values['accounts-file']) : [])])];
  const dryRun = Boolean(values['dry-run']);

  const settings = chainSettings();
  const chain = new KevinChain(settings);
  const cred = await loadCredential(signer, { network: settings.network });
  let failures = 0;

  // account -> the desk already read from the roster (null: read it with get_desk).
  const accounts = new Map(named.map((a) => [a, null]));
  if (values.roster) {
    try {
      // get_roster_accounts lists accounts without projecting their desks, so it works however far behind
      // a desk is; each desk is then read on its own below.
      const ids = await chain.getRosterAccountIds();
      console.log(`roster: ${ids.length} desk(s)`);
      for (const id of ids) if (!accounts.has(id)) accounts.set(id, null);
    } catch (err) {
      if (dryRun) {
        console.log(`WARN get_roster_accounts failed (${errorText(err)}); dry run continues with the named accounts`);
      } else {
        console.log(`ERROR get_roster_accounts: ${errorText(err)}`);
        failures += 1;
      }
    }
  }
  console.log(`janitor ${signer} on ${settings.contractId} (${settings.network}); ${accounts.size} account(s)${dryRun ? '; dry run' : ''}`);

  const step = async (label, method, args) => {
    try {
      if (dryRun) {
        const plan = await chain.prepareCall(cred, method, args, { gasTgas });
        console.log(`WOULD CALL ${method} ${JSON.stringify(args)} nonce ${plan.nonce} key ${plan.key}`);
        return null;
      }
      const { result, txHash } = await chain.call(cred, method, args, { gasTgas });
      console.log(`${label}: ${JSON.stringify(result)} ${chain.explorerTx(txHash)}`);
      return result;
    } catch (err) {
      console.log(`ERROR ${label}: ${errorText(err)}`);
      failures += 1;
      return undefined;
    }
  };

  if (!values['no-poke']) await step('poke', 'poke', {});
  for (const [account, fromRoster] of accounts) {
    let desk = fromRoster;
    try {
      desk ??= await chain.getDesk(account);
    } catch (err) {
      // A desk too far behind for the view to project is exactly the one that needs settling.
      console.log(`WARN get_desk ${account} failed (${errorText(err)}); settling it anyway`);
    }
    if (desk && !desk.registered) {
      console.log(`SKIP ${account}: not registered`);
      continue;
    }
    if (desk && desk.on_call === false) {
      console.log(`SKIP ${account}: not on call, nothing can burn`);
      continue;
    }
    if (desk && desk.unsettled === 0) {
      console.log(`SKIP ${account}: nothing to settle`);
      continue;
    }
    if (desk) console.log(`${account}: ${desk.unsettled} unsettled, pending burn ${desk.pending_burn}`);
    // Bounded so a contract that never reports remaining = 0 cannot loop forever.
    for (let i = 0; i < 1000; i++) {
      const r = await step(`settle ${account}`, 'settle', { account_id: account, limit });
      if (!r || r.remaining === 0) break;
    }
  }
  return failures ? 1 : 0;
});
