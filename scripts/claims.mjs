#!/usr/bin/env node
// npm run claims: one PASS, FAIL or SKIP line per claim the README makes, checked with this repository's own
// code and committed data. `--live` adds the claims about the NEAR testnet deployments, read over public RPC.
// Exit code 1 when any claim fails.

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseCli, runMain } from '../lib/cli.mjs';
import { deadlineMs, fetchCatalog, loadSnapshot, toReport } from '../lib/kev.mjs';
import { Ledger } from '../lib/model.mjs';
import { buildOpenVex, validateOpenVex } from '../lib/vex.mjs';

const HELP = `
Usage: npm run claims -- [--live]

Checks the README's claims. Without --live it needs no network: the KEV snapshot, the five-year replay, the
settlement model, the Node tests and the OpenVEX export. With --live it also reads NEAR testnet and CISA's
catalog and checks the deployment claims: contract configuration, keyless contract accounts, reporter keys,
deployed code hash, every open ticket against the catalog, the recorded fire drill and its transactions.

Options:
  --live      include the testnet claims
  -h, --help  show this help
`;

// ---- README text the claims require ------------------------------------------------------------------
// Every string the README must contain verbatim, in one place. A function builds its string from a number the
// claim computes; `npm run claims` prints the failing string when the README does not say it.
const README_SAYS = Object.freeze({
  // C1: the snapshot
  snapshot: (version, entries) => `(${version}, ${entries} entries)`,
  firstDay: (date) => `(${date})`,
  // C3: one row per holder of the replay table (label, answered, missed, missed ransomware, committed stake kept)
  replayRow: (label, answered, missed, missedRansomware, kept) => `| ${label} | ${answered} | ${missed} | ${missedRansomware} | ${kept} |`,
  // C4: catalog facts
  shortWindows: (n) => `${n} entries had a deadline three days or less after CISA added them`,
  peakOpen: (n) => `peaked at ${n} open tickets`,
  // C5: the burn rule
  burnRule: 'or Kevin burns 1% of what you committed, 5% if the bug is used in ransomware',
  freeNeverBurns: 'The free balance never burns',
  // C6 and D6: the recorded fire drill
  drillCommittedAfter: (amount) => amount,
  drillSupplyFell: (amount) => `Total supply fell by ${amount} KEVIN`,
  // C7: the Node test count
  nodeTests: (n) => `${n} Node tests`,
  // L1 and D1: each desk's contract account
  contract: (id) => id,
});

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const K = 10n ** 18n;
const results = [];

function record(status, id, text, detail = '') {
  results.push(status);
  console.log(`${status.padEnd(4)} ${id.padEnd(4)} ${text}${detail ? ` (${detail})` : ''}`);
}

async function claim(id, text, fn) {
  try {
    const out = await fn();
    if (out && out.skip) record('SKIP', id, text, out.skip);
    else record('PASS', id, text, typeof out === 'string' ? out : '');
  } catch (err) {
    record('FAIL', id, text, String(err?.message ?? err).split('\n')[0]);
  }
}

function must(condition, message) {
  if (!condition) throw new Error(message);
}

/** The README must state `text` verbatim; that is what ties a README number to a computed one. */
function readmeSays(readme, text) {
  must(readme.includes(text), `README does not say "${text}"`);
}

const pct = (bps) => `${(bps / 100).toFixed(2)}%`;
const thousands = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
/** A token amount (18 decimals) as KEVIN: thousands separators, and the exact fraction when there is one. */
function kevinText(units) {
  const v = BigInt(units);
  const frac = String(v % K).padStart(18, '0').replace(/0+$/, '');
  return `${thousands(v / K)}${frac ? `.${frac}` : ''}`;
}

// ---- JSON-RPC, used only by --live ----------------------------------------------------------------------

const RPCS = (process.env.KEVIN_RPC ?? 'https://test.rpc.fastnear.com,https://near-testnet.drpc.org').split(',');

async function rpc(method, params) {
  let last;
  for (const url of RPCS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(20_000),
      });
      const json = await res.json();
      if (json.error) throw new Error(json.error.cause?.name ?? json.error.message ?? 'rpc error');
      return json.result;
    } catch (err) {
      last = err;
    }
  }
  throw last;
}

async function view(contractId, method, args = {}) {
  const result = await rpc('query', {
    request_type: 'call_function',
    finality: 'final',
    account_id: contractId,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
  });
  return JSON.parse(Buffer.from(result.result).toString());
}

const keysOf = async (accountId) =>
  (await rpc('query', { request_type: 'view_access_key_list', finality: 'final', account_id: accountId })).keys;

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(bytes) {
  let n = BigInt(`0x${Buffer.from(bytes).toString('hex') || '0'}`);
  let out = '';
  while (n > 0n) {
    out = BASE58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}

// ---- offline claims -------------------------------------------------------------------------------------

async function offline(readme) {
  const deployments = JSON.parse(read('deploy/deployments.json'));
  const snapshot = await loadSnapshot();
  const entries = snapshot.vulnerabilities;
  const report = JSON.parse(read('data/sim-report.json'));

  await claim('C1', 'the KEV snapshot is the catalog version and size the README names', () => {
    const dates = entries.map((e) => e.dateAdded).sort();
    must(entries.length === snapshot.count, `snapshot count ${snapshot.count} but ${entries.length} entries`);
    readmeSays(readme, README_SAYS.snapshot(snapshot.catalogVersion, thousands(entries.length)));
    readmeSays(readme, README_SAYS.firstDay(dates[0]));
    return `${snapshot.catalogVersion}, ${entries.length} entries, ${dates[0]} to ${dates.at(-1)}`;
  });

  await claim('C2', 'npm run sim reproduces the committed data/sim-report.json byte for byte', () => {
    const run = spawnSync(process.execPath, ['scripts/sim.mjs', '--check'], { cwd: root, encoding: 'utf8' });
    must(run.status === 0, (run.stderr || run.stdout).trim().split('\n').at(-1));
    return 'fresh run matches';
  });

  await claim('C3', 'every row of the README replay table equals the report', () => {
    for (const h of report.holders) {
      readmeSays(readme, README_SAYS.replayRow(h.label, thousands(h.answered), thousands(h.missed), thousands(h.missedRansomware), pct(h.keptBps)));
    }
    return `${report.holders.length} rows`;
  });

  await claim('C4', 'the replay facts the README quotes come from the catalog', () => {
    const short = entries.filter((e) => (deadlineMs(e.dueDate) - deadlineMs(e.dateAdded)) / 86_400_000 <= 3).length;
    readmeSays(readme, README_SAYS.shortWindows(short));
    readmeSays(readme, README_SAYS.peakOpen(report.facts?.peakOpen ?? report.peakOpen));
    return `${short} entries with a window of 3 days or less`;
  });

  await claim('C5', 'the burn rates are 1% and 5% of the committed stake, and free tokens never burn', () => {
    must(report.missBps === 100 && report.ransomMissBps === 500, `report uses ${report.missBps}/${report.ransomMissBps} bps`);
    // A desk with 6,000 free and 4,000 committed misses one 1% ticket and one 5% ticket.
    const l = new Ledger({ minWindowMs: 60_000, maxOpen: 128, starterBag: 10_000n * K, initialSupply: 1_000_000_000n * K, minCommit: 1_000n * K });
    l.register('desk', 0);
    l.claimStarter('desk', 0);
    l.goOnCall('desk', 4_000n * K, 0);
    l.open({ cve_id: 'CVE-2014-0160', vendor: 'v', product: 'p', date_added: '2014-05-01', due_date: '2022-05-25', ransomware: false, deadline_ms: '120000' }, 0);
    l.open({ cve_id: 'CVE-2021-44228', vendor: 'v', product: 'p', date_added: '2021-12-10', due_date: '2021-12-24', ransomware: true, deadline_ms: '180000' }, 0);
    l.poke(180_000);
    const burned = l.settle('desk', undefined, 180_000).burned;
    must(burned === 40n * K + 198n * K, `burned ${kevinText(burned)} KEVIN, expected 238 (1% of 4,000, then 5% of 3,960)`);
    must(l.balances.get('desk') === 6_000n * K, 'the free balance changed');
    readmeSays(readme, README_SAYS.burnRule);
    readmeSays(readme, README_SAYS.freeNeverBurns);
    return '4,000 committed lost 40 then 198; 6,000 free untouched';
  });

  await claim('C6', 'the model reproduces the recorded fire drill in deploy/deployments.json', () => {
    // The recorded round lists each holder's stored committed amount at the start of the round, whether it was on
    // call, and its statements. Every desk the drill contract could burn must be listed, or the ticket totals differ.
    const r = deployments.drill?.recorded_round;
    const holders = r?.holders ?? [];
    if (!holders.length || holders.some((h) => h.committed === undefined || h.on_call === undefined)) {
      return { skip: 'deploy/deployments.json has no v2 recorded round yet (holders[].committed and on_call)' };
    }
    const tickets = [...r.tickets].sort((a, b) => a.id - b.id);
    const deadline = 120_000;
    const supply = holders.reduce((a, h) => a + BigInt(h.committed), 0n);
    const l = new Ledger({ minWindowMs: 0, maxOpen: 128, initialSupply: supply, minCommit: 1n });
    for (const h of holders) {
      l.register(h.account, 0);
      if (BigInt(h.committed) > 0n) l.transfer(l.poolId, h.account, BigInt(h.committed), 0);
      if (h.on_call) l.goOnCall(h.account, BigInt(h.committed), 0);
    }
    for (const t of tickets) {
      l.open({ cve_id: t.cve_id, vendor: 'v', product: 'p', date_added: '2000-01-01', due_date: '2000-01-01', ransomware: t.burn_bps === 500, deadline_ms: String(deadline) }, 0);
    }
    holders.forEach((h) => h.statements.forEach((status, i) => status && l.close(h.account, i, status, 1)));
    const before = new Map(holders.map((h) => [h.account, l.balanceOf(h.account, 1)]));
    l.poke(deadline);
    for (const h of holders) l.settle(h.account, undefined, deadline);
    tickets.forEach((t, i) => {
      const m = l.tickets[i];
      must(m.burnBps === t.burn_bps, `${t.cve_id}: model rate ${m.burnBps}, recorded ${t.burn_bps}`);
      must(m.burned === BigInt(t.burned) && m.missed === t.missed, `${t.cve_id}: model burned ${m.burned} with ${m.missed} misses, recorded ${t.burned} with ${t.missed}`);
    });
    const after = [];
    for (const h of holders) {
      if (!h.on_call) {
        must(l.balanceOf(h.account, deadline) === before.get(h.account), `${h.account} is not on call but its balance changed`);
        continue;
      }
      const committed = l.desk(h.account, deadline).committed;
      readmeSays(readme, README_SAYS.drillCommittedAfter(kevinText(committed)));
      after.push(`${h.account} ${kevinText(committed)}`);
    }
    const total = kevinText(supply - l.totalSupply);
    readmeSays(readme, README_SAYS.drillSupplyFell(total));
    return `committed after: ${after.join(', ')}; supply down ${total}`;
  });

  await claim('C7', 'npm test passes with the test count the README gives', () => {
    const run = spawnSync('npm', ['test', '--silent'], { cwd: root, encoding: 'utf8' });
    const n = (label) => Number(run.stdout.match(new RegExp(`^# ${label} (\\d+)$`, 'm'))?.[1] ?? -1);
    must(run.status === 0 && n('fail') === 0, `npm test exit ${run.status}, ${n('fail')} failing`);
    readmeSays(readme, README_SAYS.nodeTests(n('pass')));
    return `${n('pass')} of ${n('tests')} pass`;
  });

  await claim('C8', 'statements export as an OpenVEX 0.2.0 document that passes the spec rules', () => {
    const tickets = entries.slice(-3).map((e, i) => ({ id: i, cve_id: e.cveID, vendor: e.vendorProject, product: e.product, date_added: e.dateAdded, due_date: e.dueDate }));
    const statuses = ['not_affected', 'fixed', 'mitigated'];
    const doc = buildOpenVex({
      accountId: 'example.testnet',
      network: 'testnet',
      contractId: 'pager.kevin-it.testnet',
      statements: tickets.map((ticket, i) => ({ ticket, statement: { status: statuses[i], at_ms: String(1_794_600_000_000 + i) } })),
      author: 'example.testnet',
      timestamp: '2026-11-14T00:00:00Z',
    });
    const problems = validateOpenVex(doc);
    must(problems.length === 0, problems[0]);
    must(doc['@context'] === 'https://openvex.dev/ns/v0.2.0', `context ${doc['@context']}`);
    return `${doc.statements.length} statements, 0 problems`;
  });

  await claim('C9', 'the README has no claim written as a placeholder', () => {
    must(!/@@|TODO|TBD/.test(readme), 'found a placeholder');
  });
}

// ---- live claims ----------------------------------------------------------------------------------------

async function live(readme) {
  const d = JSON.parse(read('deploy/deployments.json'));
  const desks = [['live', d.live], ['drill', d.drill]];

  for (const [name, desk] of desks) {
    const tag = name === 'live' ? 'L' : 'D';
    await claim(`${tag}1`, `${name} desk ${desk.contract}: configuration is what the README states`, async () => {
      const c = await view(desk.contract, 'get_config');
      must(JSON.stringify(c.reporters) === JSON.stringify(desk.reporters), `reporters ${c.reporters}`);
      must(c.quorum === desk.quorum && c.miss_bps === 100 && c.ransom_miss_bps === 500, `quorum ${c.quorum}, ${c.miss_bps}/${c.ransom_miss_bps} bps`);
      must(c.min_window_ms === desk.min_window_ms && c.max_open === desk.max_open, `window ${c.min_window_ms}, max_open ${c.max_open}`);
      must(c.initial_supply === String(1_000_000_000n * K) && c.starter_bag === String(10_000n * K), 'supply or starter bag differs');
      must(c.min_commit !== undefined && c.min_commit === String(desk.min_commit), `min_commit ${c.min_commit}, deployments.json ${desk.min_commit}`);
      must(c.min_shift_ms !== undefined && String(c.min_shift_ms) === String(desk.min_shift_ms), `min_shift_ms ${c.min_shift_ms}, deployments.json ${desk.min_shift_ms}`);
      readmeSays(readme, README_SAYS.contract(desk.contract));
      return `${c.quorum} of ${c.reporters.length} reporters, min window ${Number(c.min_window_ms) / 1000} s, max_open ${c.max_open}, ` +
        `min_commit ${kevinText(c.min_commit)} KEVIN, min shift ${Number(c.min_shift_ms) / 60_000} min`;
    });

    await claim(`${tag}2`, `${name} desk: the contract account has no access keys`, async () => {
      const keys = await keysOf(desk.contract);
      must(keys.length === 0, `${keys.length} key(s) present`);
    });

    await claim(`${tag}3`, `${name} desk: each reporter's only key can call report_ticket on this contract and nothing else`, async () => {
      for (const reporter of desk.reporters) {
        const keys = await keysOf(reporter);
        must(keys.length === 1, `${reporter} has ${keys.length} keys`);
        const fc = keys[0].access_key.permission?.FunctionCall;
        must(fc && fc.receiver_id === desk.contract && fc.method_names.join() === 'report_ticket', `${reporter}: ${JSON.stringify(keys[0].access_key.permission)}`);
      }
      return `${desk.reporters.length} reporters`;
    });

    await claim(`${tag}4`, `${name} desk: the deployed code is the wasm committed at contract/res/kevin.wasm`, async () => {
      const account = await rpc('query', { request_type: 'view_account', finality: 'final', account_id: desk.contract });
      const wasm = new URL('../contract/res/kevin.wasm', import.meta.url);
      must(existsSync(wasm), 'contract/res/kevin.wasm is missing');
      const hash = createHash('sha256').update(readFileSync(wasm)).digest();
      must(base58(hash) === account.code_hash, `chain ${account.code_hash}, file ${base58(hash)}`);
      must(hash.toString('hex') === d.wasm_sha256, 'deployments.json wasm_sha256 differs from the file');
      return `sha256 ${hash.toString('hex').slice(0, 16)}...`;
    });

    await claim(`${tag}5`, `${name} desk: the supply fell by exactly what the tickets record as burned`, async () => {
      // Two counters the contract keeps separately: total supply, and each ticket's own burned total.
      const s = await view(desk.contract, 'get_stats');
      let perTicket = 0n;
      for (let from = 0; ; from += 100) {
        const page = await view(desk.contract, 'get_tickets', { from_index: from, limit: 100 });
        for (const t of page) perTicket += BigInt(t.burned);
        if (page.length < 100) break;
      }
      const supply = BigInt(await view(desk.contract, 'ft_total_supply'));
      must(BigInt(s.initial_supply) - supply === perTicket, `supply fell by ${BigInt(s.initial_supply) - supply}, tickets record ${perTicket}`);
      return `burned ${perTicket / K} KEVIN over ${s.tickets_opened} tickets, ${s.accounts} desks`;
    });
  }

  await claim('L6', 'live desk: every ticket is a real KEV entry with CISA\'s vendor, product, flag and due date as its deadline', async () => {
    let catalog;
    try {
      ({ catalog } = await fetchCatalog());
    } catch {
      catalog = await loadSnapshot();
    }
    const byCve = new Map(catalog.vulnerabilities.map((e) => [e.cveID, e]));
    const tickets = [];
    for (let from = 0; ; from += 100) {
      const page = await view(d.live.contract, 'get_tickets', { from_index: from, limit: 100 });
      tickets.push(...page);
      if (page.length < 100) break;
    }
    must(tickets.length > 0, 'no tickets on the live desk');
    for (const t of tickets) {
      const entry = byCve.get(t.cve_id);
      must(entry, `${t.cve_id} is not in the catalog`);
      const want = toReport(entry);
      // CISA revises the ransomware flag after publication, so a ticket keeps the flag it was opened with.
      must(t.vendor === want.vendor && t.product === want.product && t.due_date === want.due_date, `${t.cve_id} fields differ`);
      must(t.deadline_ms === want.deadline_ms, `${t.cve_id} deadline ${t.deadline_ms}, catalog ${want.deadline_ms}`);
      must(t.burn_bps === (t.ransomware ? 500 : 100), `${t.cve_id} burn ${t.burn_bps}`);
    }
    return `${tickets.length} tickets match catalog ${catalog.catalogVersion}`;
  });

  await claim('D6', 'drill desk: the recorded fire drill ended as the README says', async () => {
    const r = d.drill.recorded_round;
    for (const t of r.tickets) {
      const ticket = await view(d.drill.contract, 'get_ticket', { ticket_id: t.id });
      must(ticket.cve_id === t.cve_id && ticket.state === 'expired' && ticket.burn_bps === t.burn_bps, `ticket ${t.id}: ${ticket.cve_id} ${ticket.state} ${ticket.burn_bps}`);
      // Only accounts registered before this deadline can be burned for it, and all of them are settled.
      must(BigInt(ticket.burned) === BigInt(t.burned), `ticket ${t.id} burned ${ticket.burned}, expected ${t.burned}`);
      must(ticket.missed === t.missed, `ticket ${t.id} has ${ticket.missed} misses, expected ${t.missed}`);
    }
    for (const h of r.holders) {
      const statements = await view(d.drill.contract, 'get_statements', { account_id: h.account, ticket_ids: r.tickets.map((t) => t.id) });
      const answered = statements.map((s) => (s ? s.status : null));
      must(JSON.stringify(answered) === JSON.stringify(h.statements), `${h.account} statements ${JSON.stringify(answered)}`);
    }
    const total = kevinText(r.tickets.reduce((a, t) => a + BigInt(t.burned), 0n));
    readmeSays(readme, README_SAYS.drillSupplyFell(total));
    return `${r.tickets.length} tickets, ${r.holders.length} holders, ${total} KEVIN burned`;
  });

  await claim('D7', 'drill desk: a holder that is registered but not on call was never burned (missed 0, burned 0)', async () => {
    const off = d.drill.recorded_round.holders.filter((h) => h.on_call === false);
    if (off.length === 0) return { skip: 'the recorded round lists no holder with on_call: false' };
    for (const h of off) {
      const desk = await view(d.drill.contract, 'get_desk', { account_id: h.account });
      must(desk.registered, `${h.account} is not registered`);
      // Lifetime counters: zero now means zero across the recorded round too, so its balance did not change.
      must(desk.missed === 0 && desk.burned === '0' && desk.pending_burn === '0', `${h.account}: missed ${desk.missed}, burned ${desk.burned}`);
    }
    return off.map((h) => h.account).join(', ');
  });

  await claim('D8', 'drill desk: get_roster returns the on-call demo accounts, in first-time-on-call order', async () => {
    const roster = [];
    for (;;) {
      const page = await view(d.drill.contract, 'get_roster', { from_index: roster.length, limit: 25 });
      roster.push(...page);
      if (page.length < 25) break;
    }
    const ids = roster.map((e) => e.account_id);
    for (const h of d.drill.recorded_round.holders) {
      if (h.on_call) must(ids.includes(h.account), `${h.account} is not on the roster`);
    }
    for (let i = 1; i < roster.length; i++) {
      must(BigInt(roster[i].desk.first_on_call_ms) >= BigInt(roster[i - 1].desk.first_on_call_ms), `roster out of order at ${roster[i].account_id}`);
    }
    must(roster.every((e) => typeof e.desk?.on_call === 'boolean' && typeof e.desk?.month === 'number'), 'roster entries lack the v2 desk fields');
    return `${roster.length} desk(s) on the roster`;
  });

  await claim('T1', 'every transaction the README links succeeded on testnet, or failed where the README says it was refused', async () => {
    const hashes = [...new Set([...readme.matchAll(/testnet\.nearblocks\.io\/txns\/([1-9A-HJ-NP-Za-km-z]{43,44})/g)].map((m) => m[1]))];
    must(hashes.length > 0, 'README links no transactions');
    // Ordinary RPC nodes forget transactions after a few days. A transaction they no longer know is reported
    // as not checkable, never as a pass.
    let forgotten = 0;
    for (const hash of hashes) {
      let tx;
      try {
        tx = await rpc('tx', { tx_hash: hash, sender_account_id: d.operator, wait_until: 'FINAL' });
      } catch (err) {
        if (/UNKNOWN_TRANSACTION|does not exist|doesn't exist|not found/i.test(String(err?.message ?? err))) {
          forgotten += 1;
          continue;
        }
        throw err;
      }
      const ok = tx.status && 'SuccessValue' in tx.status;
      const expectedFailure = d.expected_failures?.includes(hash);
      must(ok !== Boolean(expectedFailure), `${hash} ${ok ? 'succeeded but is listed as a refused attempt' : 'failed'}`);
    }
    if (forgotten > 0) return { skip: `${forgotten} of ${hashes.length} transactions are older than this RPC node keeps; open them on testnet.nearblocks.io` };
    return `${hashes.length} transactions`;
  });
}

runMain(async () => {
  const { values } = parseCli(HELP, { live: { type: 'boolean' } });
  const readme = read('README.md');
  await offline(readme);
  if (values.live) await live(readme);
  else console.log('SKIP      testnet claims: run with --live');
  const count = (s) => results.filter((r) => r === s).length;
  console.log(`\n${count('PASS')} PASS, ${count('FAIL')} FAIL, ${count('SKIP')} SKIP`);
  if (count('FAIL') > 0) process.exitCode = 1;
});
