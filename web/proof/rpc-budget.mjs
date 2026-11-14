// RPC budget check: opens the built app against the real testnet contracts (no ?mock) on the live desk
// and on the fire drill desk, one idle unregistered tab for 60 s each, counts the RPC POSTs it sends
// and fails if a desk goes over its budget or if any console or page error occurs.
// Usage: node web/proof/rpc-budget.mjs   (env: BASE, default http://localhost:4151/; SECONDS, default 60)
import puppeteer from 'puppeteer';

const BASE = process.env.BASE || 'http://localhost:4151/';
const SECONDS = Number(process.env.SECONDS || 60);
const BUDGET = { live: 3, drill: 7 }; // requests per minute for an idle tab
const RPC = /test\.rpc\.fastnear\.com|near-testnet\.drpc\.org/;

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
let failed = false;
try {
  for (const desk of ['live', 'drill']) {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    const errors = [];
    const calls = [];
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => {
      if (r.method() !== 'POST' || !RPC.test(r.url())) return;
      let method = '?';
      try {
        const body = JSON.parse(r.postData() || '{}');
        method = body.params?.method_name || body.method || '?';
      } catch {
        /* not JSON */
      }
      calls.push({ at: Date.now(), method, host: new URL(r.url()).host });
    });
    const start = Date.now();
    await page.goto(`${BASE}${desk === 'drill' ? '?desk=drill' : ''}`, { waitUntil: 'domcontentloaded' });
    await new Promise((r) => setTimeout(r, SECONDS * 1000));
    const perMin = (calls.length * 60) / SECONDS;
    const byMethod = calls.reduce((m, c) => ((m[c.method] = (m[c.method] || 0) + 1), m), {});
    const hosts = [...new Set(calls.map((c) => c.host))];
    // The first load is a one-off; the steady-state rate is what an idle tab costs.
    const steady = calls.filter((c) => c.at - start > 15_000);
    const steadyPerMin = (steady.length * 60) / Math.max(1, SECONDS - 15);
    const shown = await page.evaluate(() => ({
      supply: document.querySelector('.supply-main .supply-value')?.textContent,
      open: document.querySelectorAll('.queue .ticket:not(.is-lapsed)').length,
      trouble: Boolean(document.querySelector('.rpc-trouble')),
    }));
    const ok = steadyPerMin <= BUDGET[desk] && errors.length === 0;
    if (!ok) failed = true;
    console.log(
      `${ok ? 'PASS' : 'FAIL'} ${desk}: ${calls.length} RPC POSTs in ${SECONDS} s (${perMin.toFixed(1)}/min incl. first load; ` +
        `${steadyPerMin.toFixed(1)}/min after the first 15 s, budget ${BUDGET[desk]}); by method ${JSON.stringify(byMethod)}; ` +
        `hosts ${hosts.join(', ')}; console errors ${errors.length}${errors.length ? ` (${errors.slice(0, 3).join(' | ')})` : ''}; ` +
        `screen ${JSON.stringify(shown)}`,
    );
    await ctx.close();
  }
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
