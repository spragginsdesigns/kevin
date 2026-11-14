// Walks the v2 On-Call Program on the in-memory demo chain (?mock=1) in headless Chrome, at 1440x900
// and at 375x812 with touch: load, open a guest desk, holder state, take the pager, answer a ticket,
// see the leaderboard row, clock out refused for the shift, jump to the end of the shift, clock out
// refused for the queue, answer the rest, clock out. Also renders the empty-roster, roster-error and
// fire-drill states. Screenshots and a JSON summary go to PROOF_DIR.
// Usage: node web/proof/oncall-walk.mjs   (env: KEVIN_URL, default http://localhost:4190/;
//                                          PROOF_DIR, default web/proof/out/oncall)
import puppeteer from 'puppeteer';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const BASE = process.env.KEVIN_URL || 'http://localhost:4190/';
const OUT = resolve(process.env.PROOF_DIR || 'web/proof/out/oncall');
const VIEWPORTS = [
  { name: '1440', width: 1440, height: 900, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  { name: '375', width: 375, height: 812, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];

function check(vp, step, ok, observed) {
  results.push({ viewport: vp.name, step, ok: Boolean(ok), observed });
  console.log(`${ok ? 'PASS' : 'FAIL'} [${vp.name}] ${step}: ${observed}`);
}

async function text(page, sel) {
  return page.$eval(sel, (el) => el.textContent.replace(/\s+/g, ' ').trim()).catch(() => null);
}

async function waitText(page, sel, re, timeout = 15000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const t = await text(page, sel);
    if (t && re.test(t)) return t;
    await sleep(120);
  }
  throw new Error(`timed out waiting for ${sel} ~ ${re}`);
}

async function press(vp, handle) {
  await handle.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await sleep(150);
  if (vp.hasTouch) await handle.tap();
  else await handle.click();
}

async function pressText(page, vp, sel, re) {
  for (let i = 0; i < 40; i++) {
    for (const h of await page.$$(sel)) {
      const ok = await h.evaluate((el, src) => !el.disabled && !!(el.offsetWidth || el.offsetHeight) && new RegExp(src).test(el.textContent), re.source);
      if (ok) return press(vp, h);
    }
    await sleep(150);
  }
  throw new Error(`no enabled ${sel} matching ${re}`);
}

async function overflow(page) {
  return page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
}

async function shot(page, vp, name) {
  const file = join(OUT, `${vp.name}-${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  return file;
}

async function shotOf(page, vp, name, sel) {
  const h = await page.$(sel);
  await h.evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await sleep(250);
  const file = join(OUT, `${vp.name}-${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  return file;
}

// Small tap targets among visible interactive elements (44px minimum).
async function smallTargets(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('button, a[href], summary, input')]
      .filter((el) => el.offsetWidth || el.offsetHeight)
      .filter((el) => !el.closest('.footer, .details-links, .sim, .skip, .ledger') )
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.height < 44)
      .map(({ el, r }) => `${el.tagName.toLowerCase()}.${el.className}:"${el.textContent.trim().slice(0, 30)}" ${Math.round(r.width)}x${Math.round(r.height)}`),
  );
}

async function walk(browser, vp) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport(vp);
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));
  const widths = [];
  const measure = async (step) => {
    const o = await overflow(page);
    widths.push({ step, ...o });
    return o;
  };

  // 1. load
  await page.goto(`${BASE}?mock=1`, { waitUntil: 'networkidle0' });
  const headline = await waitText(page, '.board-headline', /ticket|No open/);
  await page.waitForSelector('.roster-row:not(.roster-head)', { timeout: 15000 });
  const board = await text(page, '.board');
  const rows = await page.$$eval('.roster-row:not(.roster-head)', (r) => r.length);
  const titles = await page.$$eval('.roster-title', (r) => r.map((x) => x.textContent.trim()));
  const notes = await page.$$eval('.stub-note-text', (r) => r.map((x) => x.textContent.trim()));
  const plaque = await text(page, '.plaque');
  const o1 = await measure('load');
  check(vp, 'load: status board', /KEVIN FROM IT/.test(board) && /Next deadline:/.test(board), `${headline} | ${board.slice(0, 260)}`);
  check(vp, 'load: ticket notes', notes.length > 0, notes.slice(0, 6).join(' / '));
  check(vp, 'load: leaderboard', rows >= 6 && Boolean(plaque), `${rows} rows; plaque: ${plaque}; titles: ${[...new Set(titles)].join(', ')}`);
  check(vp, 'load: no sideways scroll', o1.scrollWidth <= o1.clientWidth, `${o1.scrollWidth} <= ${o1.clientWidth}`);
  const shots = [await shot(page, vp, '01-load')];
  shots.push(await shotOf(page, vp, '02-leaderboard', '.eotm'));
  const pagerButtons = await page.$$eval('.btn-pager', (b) => b.length);
  check(vp, 'load: answer buttons say Take the pager to answer', pagerButtons > 0, `${pagerButtons} tickets show "Take the pager to answer"`);

  // 2. open a guest desk
  await pressText(page, vp, '.desk button', /Open a guest desk/);
  await page.waitForSelector('.pager', { timeout: 20000 });
  const holderLine = await text(page, '.desk .kevin-line-text');
  const amount = await page.$eval('.pager input', (i) => i.value);
  const pagerFine = await text(page, '#pager-min');
  check(vp, 'guest desk: holder, not on call', /You hold KEVIN\. Nothing is expected of you\. Nothing will burn\. I envy you\./.test(holderLine), `line "${holderLine}", amount prefilled ${amount}, "${pagerFine}"`);
  shots.push(await shotOf(page, vp, '03-holder', '#desk'));

  // 3. take the pager
  await pressText(page, vp, '.pager button', /Take the pager/);
  await page.waitForSelector('.shift-ends', { timeout: 20000 });
  const toast1 = await waitText(page, '.toast', /Welcome to the rota/);
  const shiftEnds = await text(page, '.shift-ends');
  const committed = await text(page, '.balance-committed');
  check(vp, 'take the pager', /Shift ends/.test(shiftEnds), `${toast1} | ${shiftEnds} | ${committed}`);
  shots.push(await shotOf(page, vp, '04-on-call', '#desk'));

  // 4. answer one ticket
  const firstOpen = await page.$('.tickets .ticket:not(.is-lapsed)');
  const cve = await firstOpen.$eval('.cve', (e) => e.textContent.trim());
  await press(vp, await firstOpen.$('.btn-answer:nth-child(2)'));
  const toast2 = await waitText(page, '.toast', /Noted\. That is one more reply than most people send\./);
  const t0 = Date.now();
  const youRow = await waitText(page, '.roster-row.is-you', /Helpdesk, Tier 1/, 20000);
  const rowMs = Date.now() - t0;
  check(vp, 'answer a ticket, leaderboard row updates', /1/.test(youRow) && /Helpdesk, Tier 1/.test(youRow), `${toast2} | row updated ${rowMs} ms after the toast: ${youRow}`);
  shots.push(await shotOf(page, vp, '05-answered', '.tickets'));
  shots.push(await shotOf(page, vp, '06-my-row', '.roster-row.is-you'));

  // 5. clock out: shift not over
  await pressText(page, vp, '[data-action="clock-out"]', /Clock out/);
  const refusal1 = await waitText(page, '.refusal', /Your shift ends .* You took the pager\. The pager does not care\./);
  check(vp, 'clock out refused: shift', true, refusal1);
  shots.push(await shotOf(page, vp, '07-refused-shift', '.shift'));

  // 6. jump to the end of the shift, clock out: queue
  await pressText(page, vp, '[data-mock="shift"]', /end of my shift/);
  await sleep(1500);
  const lineAfterJump = await text(page, '.desk .kevin-line-text');
  await pressText(page, vp, '[data-action="clock-out"]', /Clock out/);
  const refusal2 = await waitText(page, '.refusal', /You can't clock out with tickets in your queue\. Nobody can\. I've tried\./);
  check(vp, 'clock out refused: tickets in the queue', true, `${refusal2} | desk line after the jump: "${lineAfterJump}"`);
  shots.push(await shotOf(page, vp, '08-refused-queue', '.shift'));

  // 7. answer the rest
  let answered = 0;
  for (let i = 0; i < 20; i++) {
    const t = await page.$('.tickets .ticket:not(.is-lapsed):not(.is-answered)');
    if (!t) break;
    await press(vp, await t.$('.btn-answer:nth-child(1)'));
    await page.waitForFunction((el) => el.classList.contains('is-answered') || !el.isConnected, { timeout: 15000 }, t);
    answered += 1;
    await sleep(300);
  }
  const queueLine = await text(page, '.desk .kevin-line-text');
  check(vp, 'answer the rest', answered > 0 && /Queue is clear|You missed/.test(queueLine), `${answered} more answered; desk line "${queueLine}"`);

  // 8. clock out
  await pressText(page, vp, '[data-action="clock-out"]', /Clock out/);
  const toast3 = await waitText(page, '.toast', /Pager returned\. Tokens returned\. Kevin remains\./);
  await page.waitForSelector('.pager', { timeout: 20000 });
  await sleep(800);
  const backLine = await text(page, '.desk .kevin-line-text');
  const freeAfter = await text(page, '.balance');
  const rowAfter = await text(page, '.roster-row.is-you');
  check(vp, 'clock out', /clocked out/.test(rowAfter || ''), `${toast3} | "${backLine}" | ${freeAfter} | row: ${rowAfter}`);
  shots.push(await shotOf(page, vp, '09-clocked-out', '#desk'));
  shots.push(await shotOf(page, vp, '10-row-after', '.roster-row.is-you'));
  const o2 = await measure('after walk');
  check(vp, 'after walk: no sideways scroll', o2.scrollWidth <= o2.clientWidth, `${o2.scrollWidth} <= ${o2.clientWidth}`);
  const small = await smallTargets(page);
  check(vp, 'tap targets at least 44px (header, queue, desk, leaderboard)', small.length === 0, small.length ? small.slice(0, 8).join('; ') : 'none under 44px');

  // Other states, same viewport
  const states = [
    ['11-empty-roster', '?mock=1&roster=0', '.eotm', /Nobody has taken the pager yet\. The plaque is still in its bubble wrap\./],
    ['12-roster-error', '?mock=1&fail=roster', '.eotm', /could not be loaded/],
    ['13-drill', '?mock=1&desk=drill', '.board', /KEVIN FROM IT/],
    ['14-rpc-down', '?mock=1&fail=rpc', '.board', /could not be read/],
  ];
  for (const [name, q, sel, re] of states) {
    const p2 = await ctx.newPage();
    await p2.setViewport(vp);
    p2.on('pageerror', (e) => errors.push(String(e)));
    p2.on('console', (m) => m.type() === 'error' && !/mock RPC outage/.test(m.text()) && errors.push(m.text()));
    await p2.goto(`${BASE}${q}`, { waitUntil: 'networkidle0' });
    let got;
    try {
      got = await waitText(p2, sel, re, 25000);
    } catch (e) {
      got = `MISSING (${await text(p2, sel)})`;
    }
    const o = await overflow(p2);
    check(vp, `state ${name}`, !got.startsWith('MISSING') && o.scrollWidth <= o.clientWidth, `${got.slice(0, 200)} | width ${o.scrollWidth}/${o.clientWidth}`);
    const h = await p2.$(sel);
    await h.evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await sleep(250);
    shots.push(join(OUT, `${vp.name}-${name}.png`));
    await p2.screenshot({ path: shots.at(-1) });
    await p2.close();
  }

  check(vp, 'console errors', errors.length === 0, errors.length ? errors.join(' | ').slice(0, 400) : '0');
  await ctx.close();
  return { viewport: vp.name, widths, errors, shots };
}

await mkdir(OUT, { recursive: true });
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
const runs = [];
try {
  for (const vp of VIEWPORTS) runs.push(await walk(browser, vp));
} finally {
  await browser.close();
}
await writeFile(join(OUT, 'summary.json'), JSON.stringify({ base: BASE, results, runs }, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
