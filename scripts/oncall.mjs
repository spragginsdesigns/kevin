#!/usr/bin/env node
// npm run oncall: the holder's bot. Answers not_affected for tickets about software you do not run, and
// pages a human for everything your inventory matches. Signs with a key that can only call close_ticket,
// so the bot can keep you answered but can never move your tokens.

import { readFile } from 'node:fs/promises';
import { errorText, parseCli, runMain, usage } from '../lib/cli.mjs';
import { KevinChain, chainSettings, credentialFromSecret } from '../lib/chain.mjs';
import { fetchCatalog, loadSnapshot, standInTickets } from '../lib/kev.mjs';
import { notOnCallLine, pageLine, parseInventory, triage } from '../lib/oncall-triage.mjs';

const HELP = `
Usage: npm run oncall -- [options]

Only an on-call desk can answer. The bot first reads your desk (get_desk); if it is not on call it prints
"<account> is not on call on <contract>: go_on_call first" and exits 1 without sending anything.

Reads your inventory (a JSON array of {"vendor": "...", "product": "..."} case-insensitive substrings; product
is optional; see scripts/inventory.example.json), then for each open ticket your account has not answered:
  no inventory match  -> close_ticket(id, "not_affected")
  inventory match     -> print a PAGE line (CVE, product, deadline, CISA's required action) and leave it open

Signing key, first found wins:
  KEVIN_ONCALL_KEY env  the secret key (ed25519:...) of a function-call key limited to close_ticket;
                        needs KEVIN_ACCOUNT or --account
  --key-file <path>     default .kevin/oncall.json, written by scripts/add-oncall-key.mjs
The key is never printed.

Environment: KEVIN_ACCOUNT, KEVIN_ONCALL_KEY, KEVIN_CONTRACT (default: the key file's contract, then
pager.kevin-it.testnet), KEVIN_NETWORK, KEVIN_RPC.

Options:
  --inventory <path>  inventory JSON (default inventory.json)
  --account <id>      the holder account (default KEVIN_ACCOUNT, then the key file)
  --key-file <path>   on-call key file (default .kevin/oncall.json)
  --dry-run           triage and build each close_ticket transaction, but do not sign or send. If the
                      contract cannot be read yet, uses the snapshot's entries with future deadlines as
                      stand-in tickets (and says so)
  -h, --help          show this help

Exit codes: 0 ok (pages are not errors), 1 not on call, a close failed or the run could not complete,
2 bad arguments.
`;

async function loadKey(values, env) {
  const keyFile = values['key-file'] ?? '.kevin/oncall.json';
  if (env.KEVIN_ONCALL_KEY) {
    const accountId = values.account ?? env.KEVIN_ACCOUNT;
    if (!accountId) usage('KEVIN_ONCALL_KEY needs KEVIN_ACCOUNT or --account');
    return { cred: credentialFromSecret(accountId, env.KEVIN_ONCALL_KEY, 'KEVIN_ONCALL_KEY'), contractId: null };
  }
  let json;
  try {
    json = JSON.parse(await readFile(keyFile, 'utf8'));
  } catch (err) {
    usage(`no on-call key: set KEVIN_ONCALL_KEY or create ${keyFile} with scripts/add-oncall-key.mjs (${errorText(err)})`);
  }
  const accountId = values.account ?? env.KEVIN_ACCOUNT ?? json.account_id;
  if (json.account_id && accountId !== json.account_id) usage(`${keyFile} belongs to ${json.account_id}, not ${accountId}`);
  const cred = credentialFromSecret(accountId, json.private_key, keyFile);
  if (json.public_key && json.public_key !== cred.publicKey) usage(`${keyFile}: public_key does not match private_key`);
  return { cred, contractId: json.contract_id ?? null };
}

/** CISA's requiredAction for a CVE: the committed snapshot first, the live catalog only if needed. */
function actionLookup(snapshot) {
  const known = new Map(snapshot.vulnerabilities.map((e) => [e.cveID, e.requiredAction]));
  let live = null;
  return async (cve) => {
    if (known.has(cve)) return known.get(cve);
    live ??= fetchCatalog().then(
      ({ catalog }) => new Map(catalog.vulnerabilities.map((e) => [e.cveID, e.requiredAction])),
      () => new Map(),
    );
    return (await live).get(cve);
  };
}

runMain(async () => {
  const { values } = parseCli(HELP, {
    inventory: { type: 'string' },
    account: { type: 'string' },
    'key-file': { type: 'string' },
    'dry-run': { type: 'boolean' },
  });
  const env = process.env;
  const inventoryPath = values.inventory ?? 'inventory.json';
  let inventory;
  try {
    inventory = parseInventory(JSON.parse(await readFile(inventoryPath, 'utf8')));
  } catch (err) {
    usage(`inventory ${inventoryPath}: ${errorText(err)}`);
  }
  const { cred, contractId: fileContract } = await loadKey(values, env);
  const settings = chainSettings({ ...env, KEVIN_CONTRACT: env.KEVIN_CONTRACT || fileContract || '' });
  const chain = new KevinChain(settings);
  const snapshot = await loadSnapshot();
  const requiredAction = actionLookup(snapshot);
  const nowMs = Date.now();
  const dryRun = Boolean(values['dry-run']);
  console.log(`${cred.accountId} on ${settings.contractId} (${settings.network}); ${inventory.length} inventory pattern(s)${dryRun ? '; dry run' : ''}`);

  let tickets;
  let statements;
  try {
    const stop = notOnCallLine(await chain.getDesk(cred.accountId), cred.accountId, settings.contractId);
    if (stop) {
      console.log(stop);
      return 1;
    }
    tickets = await chain.getOpenTickets();
    statements = await chain.getStatements(cred.accountId, tickets.map((t) => t.id));
  } catch (err) {
    if (!dryRun) throw err;
    console.log(`WARN contract not readable (${errorText(err)}); dry run uses snapshot entries with future deadlines as stand-in tickets`);
    tickets = standInTickets(snapshot.vulnerabilities, { nowMs });
    statements = tickets.map(() => null);
  }

  let failures = 0;
  const counts = { close: 0, page: 0, skip: 0 };
  for (const d of triage({ tickets, statements, inventory, nowMs })) {
    counts[d.action] += 1;
    const t = d.ticket;
    if (d.action === 'skip') {
      console.log(`SKIP ${t.cve_id} ticket #${t.id}: ${d.reason}`);
    } else if (d.action === 'page') {
      console.log(pageLine(t, await requiredAction(t.cve_id)));
    } else {
      const args = { ticket_id: t.id, status: 'not_affected' };
      try {
        if (dryRun) {
          const plan = await chain.prepareCall(cred, 'close_ticket', args);
          console.log(`WOULD CLOSE ${t.cve_id} ticket #${t.id} not_affected (${t.vendor} ${t.product}); key ${plan.key}${plan.keyAllows ? '' : ' CANNOT call close_ticket'}`);
          if (!plan.keyAllows) failures += 1;
        } else {
          const { txHash } = await chain.call(cred, 'close_ticket', args);
          console.log(`CLOSED ${t.cve_id} ticket #${t.id} not_affected ${chain.explorerTx(txHash)}`);
        }
      } catch (err) {
        console.log(`ERROR ${t.cve_id} ticket #${t.id}: ${errorText(err)}`);
        failures += 1;
      }
    }
  }
  console.log(`${counts.close} to close, ${counts.page} paged, ${counts.skip} skipped, ${failures} failure(s)`);
  return failures ? 1 : 0;
});
