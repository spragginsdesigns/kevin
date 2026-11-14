#!/usr/bin/env node
// npm run drill: open fire-drill tickets. Real CISA KEV entries from the past are reported with a deadline a
// few minutes away instead of CISA's original due date, so a deadline can be watched passing without waiting
// days. Meant for a desk deployed with a short min_window_ms (the drill desk); the live desk refuses nothing
// here either, but its tickets are meant to carry CISA's real deadlines, so do not point this at it.

import { errorText, parseCli, runMain, usage } from '../lib/cli.mjs';
import { DRILL_CONTRACT, KevinChain, chainSettings, loadCredential } from '../lib/chain.mjs';
import { loadSnapshot, toReport } from '../lib/kev.mjs';
import { isBenignReportError } from '../lib/reporter-plan.mjs';

// Entries most readers will recognise. A round takes the first ones that are not on the desk yet.
const WELL_KNOWN = [
  'CVE-2021-44228', // Log4Shell
  'CVE-2014-0160', // Heartbleed
  'CVE-2023-34362', // MOVEit Transfer
  'CVE-2022-22965', // Spring4Shell
  'CVE-2017-0144', // EternalBlue
  'CVE-2023-20198', // Cisco IOS XE Web UI
  'CVE-2023-4966', // Citrix Bleed
  'CVE-2023-23397', // Outlook
  'CVE-2024-3400', // PAN-OS GlobalProtect
  'CVE-2021-26855', // ProxyLogon
  'CVE-2024-1709', // ScreenConnect
  'CVE-2019-0708', // BlueKeep
  'CVE-2020-1472', // Zerologon
  'CVE-2021-34527', // PrintNightmare
  'CVE-2022-30190', // Follina
  'CVE-2019-19781', // Citrix ADC
  'CVE-2018-13379', // FortiOS
  'CVE-2021-40444', // MSHTML
  'CVE-2020-0796', // SMBGhost
  'CVE-2021-21972', // vCenter
];

const HELP = `
Usage: npm run drill -- [options]

Opens fire-drill tickets on the contract in KEVIN_CONTRACT (default ${DRILL_CONTRACT}): real KEV entries
from data/kev-snapshot.json, reported by every account in KEVIN_REPORTERS with the same deadline a few minutes
from now. The entry's own dateAdded and dueDate stay on the ticket; only the deadline is compressed.

Environment: KEVIN_REPORTERS (required), KEVIN_CONTRACT, KEVIN_NETWORK, KEVIN_RPC, NEAR_CREDENTIALS_DIR.

Options:
  --count <n>      how many tickets to open this round (default 2)
  --minutes <n>    minutes from now to the deadline (default 4; may be fractional)
  --cve <id>       open this entry (repeatable); otherwise the next entries not on the desk yet, well-known
                   ones first, then the rest of the catalog oldest first
  --dry-run        print the reports; send nothing
  -h, --help       show this help

Exit codes: 0 ok, 1 a report failed, 2 bad arguments.
`;

runMain(async () => {
  const { values } = parseCli(HELP, {
    count: { type: 'string' },
    minutes: { type: 'string' },
    cve: { type: 'string', multiple: true },
    'dry-run': { type: 'boolean' },
  });
  const reporters = (process.env.KEVIN_REPORTERS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (reporters.length === 0) usage('KEVIN_REPORTERS is required');
  const count = Number(values.count ?? 2);
  const minutes = Number(values.minutes ?? 4);
  if (!Number.isInteger(count) || count < 1 || count > 20) usage('--count must be an integer from 1 to 20');
  if (!(minutes > 0) || minutes > 24 * 60) usage('--minutes must be between 0 and 1440');
  const dryRun = Boolean(values['dry-run']);

  const settings = chainSettings({ ...process.env, KEVIN_CONTRACT: process.env.KEVIN_CONTRACT || DRILL_CONTRACT });
  const chain = new KevinChain(settings);
  const config = await chain.getConfig();
  const snapshot = await loadSnapshot();
  const byCve = new Map(snapshot.vulnerabilities.map((e) => [e.cveID, e]));

  // Candidates in a fixed order: the well-known entries first, then the rest of the catalog oldest first.
  // The desk's ticket count says roughly how far down that list earlier rounds got, so a round does not
  // re-ask the chain about hundreds of entries it has already used.
  const explicit = Boolean(values.cve?.length);
  const wellKnown = new Set(WELL_KNOWN);
  const ordered = explicit
    ? values.cve
    : [...WELL_KNOWN.filter((cve) => byCve.has(cve)), ...snapshot.vulnerabilities.map((e) => e.cveID).filter((cve) => !wellKnown.has(cve))];
  const stats = explicit ? null : await chain.getStats();
  const start = explicit ? 0 : Math.max(0, Math.min(Number(stats.tickets_opened) - 3, ordered.length - count));
  const picked = [];
  for (const cve of ordered.slice(start)) {
    if (picked.length >= count) break;
    const entry = byCve.get(cve);
    if (!entry) usage(`${cve} is not in the snapshot`);
    if (await chain.getTicketByCve(cve)) continue;
    picked.push(entry);
  }
  if (picked.length === 0) {
    console.log('nothing to open: every candidate is already on this desk');
    return;
  }

  // One deadline for the whole round, fixed before the first report, so every reporter sends byte-identical
  // reports and the quorum can form.
  const deadlineMs = Date.now() + Math.round(minutes * 60_000);
  if (deadlineMs < Date.now() + Number(config.min_window_ms) + 20_000) {
    usage(`--minutes ${minutes} is inside this desk's minimum window of ${Number(config.min_window_ms) / 1000} s (plus 20 s to land)`);
  }
  const reports = picked.map((entry) => ({ ...toReport(entry), deadline_ms: String(deadlineMs) }));
  console.log(
    `drill on ${settings.contractId} (${settings.network}): ${reports.length} ticket(s), deadline ${new Date(deadlineMs).toISOString()}${dryRun ? '; dry run' : ''}`,
  );

  let failures = 0;
  for (const reporter of reporters) {
    const cred = dryRun ? null : await loadCredential(reporter, { network: settings.network });
    for (const report of reports) {
      if (dryRun) {
        console.log(`WOULD SEND ${reporter} report_ticket ${JSON.stringify({ report })}`);
        continue;
      }
      try {
        const { result, txHash } = await chain.call(cred, 'report_ticket', { report });
        console.log(`SENT ${report.cve_id} by ${reporter}: ${JSON.stringify(result)} ${chain.explorerTx(txHash)}`);
      } catch (err) {
        const message = errorText(err);
        if (isBenignReportError(message)) {
          console.log(`SKIP ${report.cve_id} by ${reporter}: ${message}`);
        } else {
          failures += 1;
          console.error(`FAILED ${report.cve_id} by ${reporter}: ${message}`);
        }
      }
    }
  }
  if (failures > 0) process.exitCode = 1;
});
