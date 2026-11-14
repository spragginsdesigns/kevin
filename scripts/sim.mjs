#!/usr/bin/env node
// npm run sim: replay five years of real KEV deadlines through the settlement model for on-call desks. No network,
// no AI.

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseCli, runMain } from '../lib/cli.mjs';
import { loadSnapshot } from '../lib/kev.mjs';
import { simulate } from '../lib/simulate.mjs';

const HELP = `
Usage: npm run sim -- [options]

Replays every entry in data/kev-snapshot.json, from the first KEV day, with its real dateAdded and dueDate,
through lib/model.mjs for six holder calendars. Each holder is an on-call desk: on the first day it claims the
starter bag, commits all of it with go_on_call and never clocks out, so every miss burns from that committed
stake. A ticket opens at dateAdded 00:00 UTC and its deadline is dueDate 23:59:59 UTC. Prints catalog facts and
the headline table, then writes data/sim-report.json (byte-identical for the same snapshot).

Options:
  --snapshot <path>  KEV snapshot to replay (default data/kev-snapshot.json)
  --out <path>       report path (default data/sim-report.json)
  --check            do not write; exit 1 if the report on disk differs from a fresh run
  -h, --help         show this help

Exit codes: 0 ok, 1 error or --check mismatch, 2 bad arguments.
`;

const DEFAULT_OUT = fileURLToPath(new URL('../data/sim-report.json', import.meta.url));

const pct = (bps) => `${(bps / 100).toFixed(2)}%`;
const share = (n, d) => `${((n * 100) / d).toFixed(2)}%`;
const kevin = (units) => (BigInt(units) / 10n ** 18n).toLocaleString('en-US');

function printFacts(r) {
  const f = r.facts;
  const w = f.windowDays;
  console.log(`KEV catalog ${f.catalogVersion} (released ${f.dateReleased}), source sha256 ${r.sourceSha256}`);
  console.log(`Entries: ${f.entries}; dateAdded ${f.firstDateAdded} to ${f.lastDateAdded}; last dueDate ${f.lastDueDate}`);
  console.log(`First KEV day ${f.firstDateAdded} added ${f.firstDayEntries} entries at once; the replay includes all of them.`);
  console.log(
    `Deadline window (dueDate minus dateAdded, days): min ${w.min}, p10 ${w.p10}, median ${w.median}, p90 ${w.p90}, ` +
      `max ${w.max}; most common ${w.mode} days (${w.modeCount} entries)`,
  );
  console.log(`  ${w.buckets.map((b) => `${b.label}d: ${b.count}`).join(' | ')}`);
  console.log(
    `Ransomware-linked (knownRansomwareCampaignUse = "Known"): ${f.ransomware} of ${f.entries} (${share(f.ransomware, f.entries)}), ` +
      'using the flag as it stands in the snapshot',
  );
  console.log(
    `Peak open tickets: ${f.peakOpen} on ${f.peakOpenDate}; above the deployed max_open of ${f.deployedMaxOpen} on ` +
      `${f.daysOverDeployedMaxOpen} days (the replay does not cap open tickets)`,
  );
  console.log(`Refused by the contract's ticket rules: ${f.refused}; still open at ${r.evaluatedAt}: ${f.openAtEvaluation}`);
  console.log(
    `Burn per miss: ${pct(r.missBps)} (${r.missBps} bps) of the committed stake, ransomware ${pct(r.ransomMissBps)} (${r.ransomMissBps} bps); ` +
      `committed stake ${kevin(r.bag)} KEVIN per holder, on call from day one; ${r.tickets} tickets from ${r.from} to ${r.to}`,
  );
}

function printTable(r) {
  const head = ['Holder', 'Seen', 'Answered', 'Missed', 'Missed ransomware', 'Still open', 'Committed stake kept'];
  const rows = r.holders.map((h) => [h.label, r.tickets, h.answered, h.missed, h.missedRansomware, h.pending, pct(h.keptBps)]);
  const widths = head.map((_, i) => Math.max(...[head, ...rows].map((row) => String(row[i]).length)));
  const line = (row) => row.map((c, i) => (i === 0 ? String(c).padEnd(widths[i]) : String(c).padStart(widths[i]))).join('  ');
  console.log(line(head));
  console.log(widths.map((n) => '-'.repeat(n)).join('  '));
  for (const row of rows) console.log(line(row));
}

runMain(async () => {
  const { values } = parseCli(HELP, {
    snapshot: { type: 'string' },
    out: { type: 'string' },
    check: { type: 'boolean' },
  });
  const report = simulate(await loadSnapshot(values.snapshot));
  const text = `${JSON.stringify(report, null, 2)}\n`;
  printFacts(report);
  console.log('');
  printTable(report);
  const out = values.out ?? DEFAULT_OUT;
  if (values.check) {
    const current = await readFile(out, 'utf8').catch(() => '');
    if (current !== text) {
      console.error(`\n${out} differs from a fresh run`);
      return 1;
    }
    console.log(`\n${out} matches a fresh run`);
    return 0;
  }
  await writeFile(out, text);
  console.log(`\nwrote ${values.out ?? 'data/sim-report.json'}`);
  return 0;
});
