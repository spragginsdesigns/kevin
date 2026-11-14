#!/usr/bin/env node
// npm run vex -- <account>: print an account's on-chain answers as an OpenVEX document.

import { parseCli, runMain, usage, errorText } from '../lib/cli.mjs';
import { KevinChain, chainSettings } from '../lib/chain.mjs';
import { loadSnapshot, standInTickets } from '../lib/kev.mjs';
import { buildOpenVex, validateOpenVex } from '../lib/vex.mjs';

const HELP = `
Usage: npm run vex -- <account> [options]

Reads every ticket (get_tickets) and the account's statements (get_statements) from the contract and prints
an OpenVEX v0.2.0 document to stdout: not_affected -> not_affected (component_not_present), fixed -> fixed,
mitigated -> affected with an action_statement quoting CISA's required action. Read-only: no key needed.

Environment: KEVIN_CONTRACT (default pager.kevin-it.testnet), KEVIN_NETWORK, KEVIN_RPC.

Options:
  --author <text>  document author (default: the account id)
  --dry-run        print the view calls it would make; if the contract cannot be read yet, build and
                   validate a stand-in document from snapshot entries, and print only the check result
  -h, --help       show this help

Exit codes: 0 ok, 1 error (including an account with no statements: OpenVEX needs at least one), 2 bad arguments.
`;

runMain(async () => {
  const { values, positionals } = parseCli(HELP, { author: { type: 'string' }, 'dry-run': { type: 'boolean' } }, { allowPositionals: true });
  if (positionals.length !== 1) usage('give exactly one account id');
  const [accountId] = positionals;
  const settings = chainSettings();
  const chain = new KevinChain(settings);
  const snapshot = await loadSnapshot();
  const actions = new Map(snapshot.vulnerabilities.map((e) => [e.cveID, e.requiredAction]));
  const base = { accountId, network: settings.network, contractId: settings.contractId, author: values.author };

  if (values['dry-run']) {
    console.error(`would call get_tickets {from_index, limit: 100} until a short page, then get_statements ` +
      `{account_id: ${JSON.stringify(accountId)}, ticket_ids: [...]} in chunks of 100, on ${settings.contractId}`);
    try {
      await chain.getStats();
      console.error('contract readable; run without --dry-run to print the document');
      return 0;
    } catch (err) {
      console.error(`contract not readable (${errorText(err)}); validating a stand-in document instead`);
    }
    const tickets = standInTickets(snapshot.vulnerabilities, { nowMs: Date.parse(snapshot.dateReleased) - 1 });
    const statuses = ['not_affected', 'fixed', 'mitigated'];
    const doc = buildOpenVex({
      ...base,
      statements: tickets.map((ticket, i) => ({
        ticket,
        statement: { status: statuses[i % 3], at_ms: ticket.opened_at_ms },
        requiredAction: actions.get(ticket.cve_id),
      })),
    });
    const problems = validateOpenVex(doc);
    console.error(`stand-in document: ${doc.statements.length} statements, ${problems.length} problem(s)${problems.length ? `: ${problems.join('; ')}` : ''}`);
    return problems.length ? 1 : 0;
  }

  const tickets = await chain.getAllTickets();
  const statements = await chain.getStatements(accountId, tickets.map((t) => t.id));
  const items = tickets
    .map((ticket, i) => ({ ticket, statement: statements[i], requiredAction: actions.get(ticket.cve_id) }))
    .filter((x) => x.statement);
  const doc = buildOpenVex({ ...base, statements: items });
  const problems = validateOpenVex(doc);
  if (problems.length) throw new Error(`built an invalid OpenVEX document: ${problems.join('; ')}`);
  console.log(JSON.stringify(doc, null, 2));
  return 0;
});
