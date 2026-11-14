// Real-chain browser check: the built app against the deployed testnet desks, at 1440 and at 375 with touch.
// One guest account per viewport. Live desk: open a desk (a holder, nothing at risk), take the pager, answer a
// ticket, see the Employee of the Month row, try to clock out (refused: the shift is not over). Fire drill: take
// the pager; one guest answers the open drill ticket, the other stays silent, is burned at the deadline out of
// what it committed and settles, with its free balance untouched.
//   BASE (default http://localhost:4151/), OUT (default proof-out/real-chain), DRILL_DEADLINE_MS (optional)
//   DRILL_ONLY=1 skips the live desk (for a second run that waits for the next drill ticket); ONLY=desktop|mobile
//   GUESTS (optional): a JSON file {desktop: guest, mobile: guest} of existing testnet accounts in the app's
//   stored-guest shape, for when the public faucet is rate limiting this IP. The faucet step is then skipped
//   and the session starts as a returning guest that still has to register on each desk.
import puppeteer from 'puppeteer';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const base = process.env.BASE || 'http://localhost:4151/';
const out = process.env.OUT || 'proof-out/real-chain';
mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const guests = process.env.GUESTS ? JSON.parse(readFileSync(process.env.GUESTS, 'utf8')) : null;
const results = [];
const note = (name, step, data) => {
  results.push({ name, step, at: new Date().toISOString(), ...data });
  console.log(name, step, JSON.stringify(data).slice(0, 600));
};

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });

async function clickButton(page, re, { within } = {}) {
  return page.evaluate(
    (src, within) => {
      const rootEl = within ? document.querySelector(within) : document;
      if (!rootEl) return false;
      const b = [...rootEl.querySelectorAll('button')].find((x) => new RegExp(src, 'i').test(x.textContent.trim()) && !x.disabled);
      if (!b) return false;
      b.scrollIntoView({ block: 'center' });
      b.click();
      return true;
    },
    re.source,
    within ?? null,
  );
}
const flat = (s) => (s || '').replace(/\s*\n+\s*/g, ' | ');
const deskText = (page) => page.evaluate(() => document.querySelector('#desk')?.innerText || '').then(flat);
const bodyText = (page) => page.evaluate(() => document.body.innerText).then(flat);
const toastInfo = (page) =>
  page.evaluate(() => {
    const t = document.querySelector('.toast');
    return t ? { text: t.innerText.replace(/\n+/g, ' '), href: t.querySelector('a')?.href || null } : null;
  });
const lastTx = (page) => page.evaluate(() => document.querySelector('.last-tx a')?.href || null);
const myRow = (page) =>
  page.evaluate(() => {
    const r = [...document.querySelectorAll('.roster-row:not(.roster-head)')].find((x) => /You/.test(x.textContent));
    return r ? r.innerText.replace(/\s*\n+\s*/g, ' | ') : null;
  });
const board = (page) => page.evaluate(() => document.querySelector('.board')?.innerText || '').then(flat);
const supply = (page) => bodyText(page).then((t) => t.match(/TOTAL SUPPLY \| ([\d,.]+)/i)?.[1] || null);
const num = (s) => Number(String(s || '').replace(/,/g, ''));
async function waitFor(page, fn, ms, every = 1500) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(every);
  }
  return null;
}

// Free and committed amounts as the desk shows them.
async function amounts(page) {
  const t = await deskText(page);
  return {
    free: t.match(/FREE BALANCE \| ([\d,.]+)/i)?.[1] ?? null,
    committed: t.match(/COMMITTED \| ([\d,.]+)/i)?.[1] ?? null,
  };
}

async function takePager(page, name, label) {
  const formReady = await waitFor(page, () => page.evaluate(() => Boolean(document.querySelector('.pager input'))), 30000);
  const prefill = formReady ? await page.$eval('.pager input', (i) => i.value) : null;
  const fine = await page.evaluate(() => document.querySelector('#pager-min')?.innerText || null);
  const clicked = await clickButton(page, /^take the pager$/, { within: '#desk' });
  const on = await waitFor(page, async () => /Shift ends/i.test(await deskText(page)), 90000, 2000);
  await sleep(800);
  note(name, `${label}: took the pager`, { prefill, fine, clicked, onCall: Boolean(on), toast: await toastInfo(page), tx: await lastTx(page), ...(await amounts(page)) });
  return Boolean(on);
}

async function session(name, viewport, mobile, silentOnDrill) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  if (mobile) await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1');
  await page.setViewport(viewport);
  if (guests?.[name]) {
    await page.evaluateOnNewDocument((g) => {
      if (!localStorage.getItem('kevin.guest.v1.testnet')) localStorage.setItem('kevin.guest.v1.testnet', g);
    }, JSON.stringify(guests[name]));
  }
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text().slice(0, 300));
  });
  page.on('pageerror', (e) => errors.push('PAGEERROR ' + String(e).slice(0, 300)));
  const shot = (file, full = false) => page.screenshot({ path: `${out}/${name}-${file}.png`, fullPage: full });
  const shotOf = async (file, sel) => {
    await page.evaluate((sel) => document.querySelector(sel)?.scrollIntoView({ block: 'start' }), sel);
    await sleep(400);
    await shot(file);
  };
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  const fail = async (what) => {
    await shot(`failed-${what.replace(/\W+/g, '-')}`, true);
    note(name, 'FAILED', { what, desk: (await deskText(page)).slice(0, 400), errors });
    await ctx.close();
    return { name, errors, failed: what };
  };

  if (!process.env.DRILL_ONLY) {
  // 1. the live desk loads: Kevin's status board, the queue, the leaderboard
  await page.goto(base, { waitUntil: 'networkidle2', timeout: 60000 });
  await waitFor(page, async () => /Next deadline:/i.test(await board(page)), 40000);
  await waitFor(page, () => page.evaluate(() => document.querySelectorAll('.roster-row:not(.roster-head)').length > 0), 30000);
  await shot('01-live-top');
  const notes = await page.$$eval('.stub-note-text', (r) => r.map((x) => x.textContent.trim()));
  const rows = await page.$$eval('.roster-row:not(.roster-head)', (r) => r.map((x) => x.innerText.replace(/\s*\n+\s*/g, ' | ')));
  note(name, 'live loaded', { board: await board(page), ticketNotes: notes.slice(0, 8), rosterRows: rows.length, firstRow: rows[0] || null, overflow: await overflow(), supply: await supply(page) });
  await shotOf('02-live-board', '.eotm');

  // 2. open a guest desk: a holder, nothing at risk
  await page.evaluate(() => document.querySelector('#desk')?.scrollIntoView({ block: 'start' }));
  const opened = await waitFor(page, () => clickButton(page, guests?.[name] ? /^register on the live desk$/ : /^open a guest desk$/, { within: '#desk' }), 20000);
  const holder = await waitFor(page, async () => /FREE BALANCE \| 10,000/i.test(await deskText(page)), 150000, 2000);
  if (!holder) return fail('guest desk');
  const holderLine = await page.evaluate(() => document.querySelector('#desk .kevin-line-text')?.innerText || null);
  const gated = await page.$$eval('.btn-pager', (b) => b.length);
  await shotOf('03-live-holder', '#desk');
  note(name, 'live: holder, not on call', { opened, kevin: holderLine, ticketsGated: gated, tx: await lastTx(page), ...(await amounts(page)) });

  // 3. take the pager
  if (!(await takePager(page, name, 'live'))) return fail('live take the pager');
  await shotOf('04-live-on-call', '#desk');
  const rowAfterPager = await waitFor(page, () => myRow(page), 45000, 2000);
  note(name, 'live: on the board', { row: rowAfterPager });

  // 4. answer the first live ticket
  const answerClicked = await clickButton(page, /^fixed$/);
  const answered = await waitFor(page, async () => /ON TIME \| 1/i.test(await deskText(page)), 90000, 2000);
  await sleep(900);
  await shot('05-live-answered');
  const answerToast = await toastInfo(page);
  const rowAfterAnswer = await waitFor(page, async () => { const r = await myRow(page); return r && /\| 1 \|/.test(r) ? r : null; }, 45000, 2000);
  note(name, 'live: answered', { clicked: answerClicked, answered: Boolean(answered), toast: answerToast, tx: await lastTx(page), row: rowAfterAnswer, kevin: await page.evaluate(() => document.querySelector('#desk .kevin-line-text')?.innerText || null) });
  if (!answered) return fail('live answer');
  await shotOf('06-live-my-row', '.eotm');

  // 5. try to clock out: the shift is not over
  await page.evaluate(() => document.querySelector('#desk')?.scrollIntoView({ block: 'start' }));
  const coClicked = await clickButton(page, /^clock out$/, { within: '#desk' });
  const refusal = await waitFor(page, () => page.evaluate(() => document.querySelector('#desk .refusal')?.innerText.replace(/\s*\n+\s*/g, ' | ') || null), 15000, 500);
  await page.evaluate(() => document.querySelector('#desk .refusal')?.scrollIntoView({ block: 'center' }));
  await sleep(300);
  await shot('07-live-clock-out-refused');
  note(name, 'live: clock out refused', { clicked: coClicked, refusal, ...(await amounts(page)), overflow: await overflow() });
  }

  // 6. fire drill: register and take the pager there
  await page.goto(base + '?desk=drill', { waitUntil: 'networkidle2', timeout: 60000 });
  await waitFor(page, async () => /KEVIN FROM IT/i.test(await board(page)), 30000);
  await sleep(1500);
  await shot('08-drill-loaded');
  note(name, 'drill loaded', { board: await board(page), supply: await supply(page) });
  await page.evaluate(() => document.querySelector('#desk')?.scrollIntoView({ block: 'start' }));
  await waitFor(page, async () => /FREE BALANCE|Register on|Open a guest/i.test(await deskText(page)), 30000);
  if (!/FREE BALANCE/i.test(await deskText(page))) {
    const reg = await waitFor(page, () => clickButton(page, /^register on the fire drill$/, { within: '#desk' }), 20000);
    const regReady = await waitFor(page, async () => /FREE BALANCE \| 10,000/i.test(await deskText(page)), 120000, 2000);
    if (!regReady) return fail('drill register');
    note(name, 'drill: registered', { reg, ...(await amounts(page)) });
  }
  if (!/Shift ends/i.test(await deskText(page))) {
    if (!(await takePager(page, name, 'drill'))) return fail('drill take the pager');
  } else {
    note(name, 'drill: already on call', { ...(await amounts(page)), desk: (await deskText(page)).slice(0, 300) });
  }
  await shotOf('09-drill-on-call', '#desk');
  // the next drill ticket opens on the quarter hour; wait for one this desk has not answered
  const openTicket = await waitFor(page, () => page.evaluate(() => {
    const m = document.body.innerText.replace(/\s*\n+\s*/g, ' | ').match(/DUE \| (\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)(?: \|)? UTC \|.*?(CVE-\d{4}-\d+) \| (RANSOMWARE: 5% BURN|STANDARD: 1% BURN)/);
    return m ? { due: m[1], cve: m[2], rate: m[3] } : null;
  }), Number(process.env.TICKET_WAIT_MS || 30000), 2000);
  note(name, 'drill: open ticket', { openTicket });
  if (!openTicket) return fail('no open drill ticket');
  const committedBefore = (await amounts(page)).committed;
  await page.evaluate(() => document.querySelector('.queue, #queue')?.scrollIntoView({ block: 'start' }));
  await sleep(400);
  await shot('09b-drill-ticket-open');

  if (!silentOnDrill) {
    const c = await waitFor(page, () => clickButton(page, /^not affected$/), 30000, 1000);
    const a = await waitFor(page, async () => /ON TIME \| 1/i.test(await deskText(page)), 90000, 2000);
    await sleep(900);
    await shot('10-drill-answered');
    note(name, 'drill: answered', { clicked: c, answered: Boolean(a), toast: await toastInfo(page), tx: await lastTx(page), committedBefore });
  }

  // 7. wait for the deadline, then look
  const deadline = Number(process.env.DRILL_DEADLINE_MS || 0) || (openTicket ? Date.parse(openTicket.due.replace(' ', 'T') + 'Z') : 0);
  if (deadline) while (Date.now() < deadline + 12000) await sleep(2000);
  await sleep(8000);
  await shot('11-drill-after-deadline');
  const before = await amounts(page);
  note(name, 'drill: after the deadline', { committedBefore, ...before, desk: (await deskText(page)).slice(0, 520), kevin: await page.evaluate(() => document.querySelector('#desk .kevin-line-text')?.innerText || null), stamps: await page.evaluate(() => /overdue|missed/i.test(document.body.innerText)) });

  if (silentOnDrill) {
    const supplyBefore = await supply(page);
    const pending = await waitFor(page, async () => (await deskText(page)).match(/Settle: burn ([\d,.]+) KEVIN/i)?.[1] || null, 60000, 1500);
    await page.evaluate(() => document.querySelector('#desk .settle')?.scrollIntoView({ block: 'center' }));
    await sleep(300);
    await shot('12-drill-pending-burn');
    const s = await waitFor(page, () => clickButton(page, /^settle: burn/, { within: '#desk' }), 30000);
    const settled = await waitFor(page, async () => !/Settle: burn/i.test(await deskText(page)) && num((await amounts(page)).committed) < num(before.committed || '5,000') + 0.0001 && !/Settling/i.test(await deskText(page)), 90000, 2000);
    await sleep(6000);
    const after = await amounts(page);
    await shotOf('13-drill-settled', '#desk');
    const supplyAfter = await supply(page);
    note(name, 'drill: settled', { pendingBurn: pending, clicked: s, settled: Boolean(settled), toast: await toastInfo(page), tx: await lastTx(page), supplyBefore, supplyAfter, freeBefore: before.free, freeAfter: after.free, committedAfter: after.committed, row: await myRow(page) });
  } else {
    const after = await amounts(page);
    note(name, 'drill: kept everything', { ...after, row: await myRow(page), pendingBurnShown: /Settle: burn/i.test(await deskText(page)) });
  }
  await shotOf('14-drill-board', '.eotm');
  await shot('15-full', true);
  const ov = await overflow();
  const account = await page.evaluate(() => {
    try {
      return JSON.parse(localStorage.getItem('kevin.guest.v1.testnet') || 'null')?.accountId || null;
    } catch {
      return null;
    }
  });
  note(name, 'done', { account, overflow: ov, errors });
  await ctx.close();
  return { name, account, overflow: ov, errors };
}

const only = process.env.ONLY;
const runs = [
  ['desktop', { width: 1440, height: 900, deviceScaleFactor: 1 }, false, true],
  ['mobile', { width: 375, height: 812, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, true, false],
].filter(([n]) => !only || only === n);
const summary = await Promise.all(runs.map((r) => session(...r)));
await browser.close();
writeFileSync(`${out}/results.json`, JSON.stringify({ summary, results }, null, 1));
console.log('SUMMARY', JSON.stringify(summary));
