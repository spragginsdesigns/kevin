#!/usr/bin/env node
// npm run roster: the Employee of the Month table for one desk, read from get_roster. Read-only: no key needed.

import { parseCli, runMain } from '../lib/cli.mjs';
import { KevinChain, ROSTER_PAGE, chainSettings } from '../lib/chain.mjs';
import { rankRoster } from '../lib/roster.mjs';

const HELP = `
Usage: npm run roster -- [options]

Pages get_roster (${ROSTER_PAGE} per call) for every desk that has ever been on call and prints them in Employee of the
Month order: answered on time this month (most first), then streak (longest first), then ignored this month
(fewest first), then first time on call (earliest first). "This month" is the current UTC month, as the
contract counts it. Answers are self-reported: an answer proves a desk replied before CISA's deadline, not that
anything was patched.

Environment: KEVIN_CONTRACT (default pager.kevin-it.testnet), KEVIN_NETWORK, KEVIN_RPC.

Options:
  --contract <id>  the desk to read (instead of KEVIN_CONTRACT)
  --json           print the sorted rows as JSON instead of the table
  -h, --help       show this help

Exit codes: 0 ok, 1 the contract could not be read, 2 bad arguments.
`;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Token amount (18 decimals, decimal string) as whole KEVIN with thousands separators and up to 2 decimals. */
function kevin(units) {
  const v = BigInt(units ?? 0);
  const whole = (v / 10n ** 18n).toLocaleString('en-US');
  const cents = (v % 10n ** 18n) / 10n ** 16n;
  return cents === 0n ? whole : `${whole}.${String(cents).padStart(2, '0').replace(/0$/, '')}`;
}

function printTable(rows, heading) {
  const head = ['Place', 'Account', 'On time (month)', 'Streak', 'Ignored (month)', 'Burned (month)', 'Committed'];
  const cells = rows.map((r) => [
    r.place,
    r.account_id,
    r.desk.month_on_time,
    r.desk.streak,
    r.desk.month_missed,
    kevin(r.desk.month_burned),
    r.desk.on_call ? kevin(r.desk.committed) : 'clocked out',
  ]);
  const widths = head.map((_, i) => Math.max(...[head, ...cells].map((row) => String(row[i]).length)));
  const line = (row) => row.map((c, i) => (i === 1 ? String(c).padEnd(widths[i]) : String(c).padStart(widths[i]))).join('  ');
  console.log(heading);
  console.log(line(head));
  console.log(widths.map((n) => '-'.repeat(n)).join('  '));
  for (const row of cells) console.log(line(row));
}

runMain(async () => {
  const { values } = parseCli(HELP, { contract: { type: 'string' }, json: { type: 'boolean' } });
  const settings = chainSettings(values.contract ? { ...process.env, KEVIN_CONTRACT: values.contract } : process.env);
  const chain = new KevinChain(settings);
  const all = await chain.getWholeRoster(ROSTER_PAGE);
  // a desk too far behind for the view to project comes back without its numbers
  const unread = all.filter((e) => !e.desk).map((e) => e.account_id);
  const rows = rankRoster(all.filter((e) => e.desk)).map((e, i) => ({ place: i + 1, ...e }));
  if (values.json) {
    console.log(JSON.stringify(rows, null, 2));
    return 0;
  }
  const now = new Date();
  const heading = `Employee of the Month: ${MONTHS[now.getUTCMonth()]} ${now.getUTCFullYear()} on ${settings.contractId} (${settings.network})`;
  if (rows.length === 0) {
    console.log(heading);
    console.log("Nobody's taken the pager yet. The plaque is still in its bubble wrap. I haven't popped any. Okay, I popped one.");
    return 0;
  }
  printTable(rows, heading);
  if (rows[0].desk.month_on_time === 0) console.log('Nobody has answered on time this month, so nobody gets the plaque.');
  return 0;
});
