#!/usr/bin/env node
// npm run reporter: the oracle bot. Each reporter fetches the KEV catalog on its own and confirms every
// entry that is not on chain yet; quorum on the contract turns matching confirmations into a ticket.

import { readFile } from 'node:fs/promises';
import { errorText, parseCli, runMain, sleep, usage } from '../lib/cli.mjs';
import { KevinChain, chainSettings, loadCredential } from '../lib/chain.mjs';
import { fetchCatalog, checkCatalog } from '../lib/kev.mjs';
import { candidates, isBenignReportError, planReports } from '../lib/reporter-plan.mjs';

const HELP = `
Usage: npm run reporter -- [options]

For each reporter account in KEVIN_REPORTERS (comma separated), fetch the KEV catalog (CISA first, then the
cisagov/kev-data mirror), and call report_ticket for every entry whose deadline is at least min_window_ms
(plus a margin) away and that get_ticket_by_cve does not know yet, soonest deadline first and never more than
the free open slots (max_open minus open tickets). Safe to run twice: "already confirmed" and "ticket exists"
count as done.

Keys come from the near-cli legacy keychain: $NEAR_CREDENTIALS_DIR (default ~/.near-credentials)
/<network>/<account>.json. Keys are never printed.

Environment:
  KEVIN_REPORTERS       reporter accounts, e.g. rep1.kevin-it.testnet,rep2.kevin-it.testnet (required)
  KEVIN_CONTRACT        contract account (default pager.kevin-it.testnet)
  KEVIN_NETWORK         testnet (default) or mainnet
  KEVIN_RPC             comma-separated RPC URLs to use instead of the defaults
  NEAR_CREDENTIALS_DIR  keychain root

Options:
  --dry-run             do everything up to signing: fetch, select, check each key on chain, build the
                        unsigned transaction, and print what would be sent
  --once                run one round and exit (default)
  --watch <minutes>     run a round every <minutes> until stopped
  --catalog <path>      use a local catalog JSON instead of fetching (same for every reporter)
  --margin-minutes <n>  extra safety on top of min_window_ms (default 10)
  --gas-tgas <n>        gas per report_ticket call in TGas (default 30)
  -h, --help            show this help

Exit codes: 0 ok, 1 a report failed or the round could not run, 2 bad arguments or configuration.
`;

// Used only by --dry-run when the contract cannot be read; the live desk's configuration.
const ASSUMED_CONFIG = { min_window_ms: '3600000', max_open: 128, reporters: null };

async function readContractState(chain, dryRun) {
  try {
    const config = await chain.getConfig();
    const open = await chain.getOpenTickets();
    return { config, open, assumed: false };
  } catch (err) {
    if (!dryRun) throw err;
    console.log(`WARN contract ${chain.contractId} not readable (${errorText(err)}); dry run assumes ` +
      `min_window_ms=${ASSUMED_CONFIG.min_window_ms}, max_open=${ASSUMED_CONFIG.max_open} and an empty chain`);
    return { config: ASSUMED_CONFIG, open: [], assumed: true };
  }
}

async function round({ chain, creds, values }) {
  const nowMs = Date.now();
  const { config, open, assumed } = await readContractState(chain, values['dry-run']);
  const stillOpen = open.filter((t) => t.state === 'open' && Number(t.deadline_ms) > nowMs).length;
  let failures = 0;
  for (const cred of creds) {
    if (config.reporters && !config.reporters.includes(cred.accountId)) {
      console.log(`ERROR ${cred.accountId} is not in the contract's reporter list`);
      failures += 1;
      continue;
    }
    let catalog;
    let source;
    try {
      if (values.catalog) {
        catalog = checkCatalog(JSON.parse(await readFile(values.catalog, 'utf8')));
        source = values.catalog;
      } else {
        ({ catalog, url: source } = await fetchCatalog());
      }
    } catch (err) {
      console.log(`ERROR ${cred.accountId}: ${errorText(err)}`);
      failures += 1;
      continue;
    }
    const { reports, skipped } = candidates(catalog.vulnerabilities, {
      nowMs,
      minWindowMs: Number(config.min_window_ms),
      marginMs: Number(values['margin-minutes'] ?? 10) * 60_000,
    });
    for (const s of skipped) console.log(`SKIP ${s.cve}: ${s.reason}`);
    const onChain = new Set();
    if (!assumed) {
      for (const r of reports) if (await chain.getTicketByCve(r.cve_id)) onChain.add(r.cve_id);
    }
    // Fresh state for each reporter: the previous reporter's confirmations may have opened tickets.
    const freeSlots = Number(config.max_open) - stillOpen;
    const { send, held } = planReports(reports, { onChain, freeSlots });
    console.log(
      `${cred.accountId}: catalog ${catalog.catalogVersion ?? '?'} from ${source}; ${reports.length} inside window, ` +
        `${onChain.size} already on chain, ${send.length} to send, ${held.length} held for open slots`,
    );
    for (const report of send) {
      const args = { report };
      const gasTgas = Number(values['gas-tgas'] ?? 30);
      try {
        if (values['dry-run']) {
          const plan = await chain.prepareCall(cred, 'report_ticket', args, { gasTgas });
          const note = plan.keyAllows ? '' : ` WARNING key cannot call report_ticket (${plan.key})`;
          console.log(`WOULD SEND ${cred.accountId} report_ticket nonce ${plan.nonce} key ${plan.key}${note} ${JSON.stringify(args)}`);
          if (!plan.keyAllows) failures += 1;
        } else {
          const { result, txHash } = await chain.call(cred, 'report_ticket', args, { gasTgas });
          console.log(`SENT ${report.cve_id} by ${cred.accountId}: ${JSON.stringify(result)} ${chain.explorerTx(txHash)}`);
        }
      } catch (err) {
        const why = errorText(err);
        if (isBenignReportError(why)) {
          console.log(`DONE ${report.cve_id} by ${cred.accountId}: ${why}`);
        } else {
          console.log(`ERROR ${report.cve_id} by ${cred.accountId}: ${why}`);
          failures += 1;
        }
      }
    }
  }
  return failures;
}

runMain(async () => {
  const { values } = parseCli(HELP, {
    'dry-run': { type: 'boolean' },
    once: { type: 'boolean' },
    watch: { type: 'string' },
    catalog: { type: 'string' },
    'margin-minutes': { type: 'string' },
    'gas-tgas': { type: 'string' },
  });
  if (values.once && values.watch) usage('--once and --watch are exclusive');
  const watchMinutes = values.watch === undefined ? null : Number(values.watch);
  if (watchMinutes !== null && !(watchMinutes > 0)) usage('--watch needs a positive number of minutes');
  const reporters = (process.env.KEVIN_REPORTERS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (reporters.length === 0) usage('set KEVIN_REPORTERS to the reporter account ids');
  const settings = chainSettings();
  const chain = new KevinChain(settings);
  const creds = [];
  for (const id of reporters) creds.push(await loadCredential(id, { network: settings.network }));
  console.log(`contract ${settings.contractId} on ${settings.network}; reporters ${reporters.join(', ')}${values['dry-run'] ? ' (dry run)' : ''}`);

  if (watchMinutes === null) return (await round({ chain, creds, values })) ? 1 : 0;
  for (;;) {
    try {
      const failures = await round({ chain, creds, values });
      console.log(`${new Date().toISOString()} round done, ${failures} failure(s); next in ${watchMinutes} min`);
    } catch (err) {
      console.log(`${new Date().toISOString()} round failed: ${errorText(err)}`);
    }
    await sleep(watchMinutes * 60_000);
  }
});
