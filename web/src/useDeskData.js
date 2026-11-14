// All chain reads for one desk, on a request diet. The periodic tick reads only get_stats; the full
// reload (recent tickets, my desk and statements, the demo desks, the roster) runs only when stats changed, about
// 2 s after an open ticket's deadline, on first load, when the tab becomes visible again and after the
// user's own writes. Reloads never overlap (a second request joins the one in flight), ticks pause
// while the tab is hidden, and a failure keeps the last good data on screen and retries with backoff.
import { useCallback, useEffect, useRef, useState } from 'react';
import { DEMO_ACCOUNTS, REFRESH_MS } from './config.js';
import { explainError, isMissingContract, isTransportError } from './errors.js';
import { markRegistered } from './guest.js';
import { monthOf, readRoster } from './roster.js';

// Anything the roster shows moves one of these: answers (statements_total), settled misses
// (total_supply, misses_total), going on call or clocking out (on_call, committed_total, roster), and
// the calendar month the monthly counters reset on.
const SIG_KEYS = ['tickets_opened', 'tickets_open', 'tickets_expired', 'statements_total', 'total_supply', 'accounts', 'on_call', 'committed_total', 'roster', 'misses_total'];
const sigOf = (s) => (s ? `${SIG_KEYS.map((k) => String(s[k])).join('|')}|${s.now_ms ? monthOf(s.now_ms) : ''}` : '');
// The demo desks only move when something burns or expires.
const demoSigOf = (s) => (s ? `${s.total_supply}|${s.tickets_expired}` : '');
const RECENT = 100; // tickets read per reload; open tickets older than that are read with get_open_tickets
const RETRY_MS = [1000, 2000, 4000, 8000, 15000];
const TROUBLE_AFTER = 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function useDeskData(chain, deskKey) {
  const [data, setData] = useState({ stats: null, config: null, open: [], all: [], loaded: false });
  const [guest, setGuest] = useState(null);
  const [desk, setDesk] = useState(null);
  const [statements, setStatements] = useState({});
  const [demo, setDemo] = useState([]);
  const [error, setError] = useState(null);
  const [trouble, setTrouble] = useState(false);
  // The Employee of the Month roster. A failed read keeps the last entries and says so.
  const [roster, setRoster] = useState({ entries: [], loaded: false, error: null });
  const S = useRef({ rosterStale: false, running: null, again: null, sig: '', demoSig: '', config: null, loaded: false, fails: 0, retry: null, pending: {} });

  const failed = useCallback(
    (e, again) => {
      const st = S.current;
      if (!isTransportError(e)) {
        setError(isMissingContract(e) ? 'missing' : explainError(e));
        setData((x) => ({ ...x, loaded: true }));
        return;
      }
      st.fails += 1;
      if (st.fails >= TROUBLE_AFTER) {
        setTrouble(true);
        if (!st.loaded) {
          setError(explainError(e));
          setData((x) => ({ ...x, loaded: true }));
        }
      }
      clearTimeout(st.retry);
      st.retry = setTimeout(again, RETRY_MS[Math.min(st.fails - 1, RETRY_MS.length - 1)]);
    },
    [],
  );

  const succeeded = useCallback(() => {
    const st = S.current;
    st.fails = 0;
    clearTimeout(st.retry);
    setTrouble(false);
    setError(null);
  }, []);

  // The roster: get_stats.roster says how many get_roster pages to read (none when empty, one for up to
  // 25 desks). A failure here never fails the rest of the page: the last roster stays on screen and the
  // next tick retries just this read.
  const loadRoster = useCallback(
    async (stats) => {
      const st = S.current;
      if (!chain.getRoster) return;
      try {
        const count = stats?.roster == null ? null : Number(stats.roster);
        const entries = await readRoster(chain.getRoster, count);
        st.rosterStale = false;
        setRoster({ entries, loaded: true, error: null });
      } catch (e) {
        st.rosterStale = true;
        setRoster((r) => ({ ...r, loaded: true, error: isMissingContract(e) ? 'missing' : explainError(e) }));
      }
    },
    [chain],
  );

  // One full reload. Returns the snapshot it committed, or null when it failed.
  const load = useCallback(
    async (opts) => {
      const st = S.current;
      const stats = opts.stats || (await chain.getStats());
      const from = Math.max(0, Number(stats.tickets_opened) - RECENT);
      // A ticket can stay open for up to 200 days, so with more than RECENT tickets on the desk an open one
      // can be older than the newest RECENT. One extra read then, and only then.
      const olderMayBeOpen = from > 0 && Number(stats.tickets_open) > 0;
      const [recent, config, , openNow] = await Promise.all([
        Number(stats.tickets_opened) ? chain.getTickets(from, RECENT) : Promise.resolve([]),
        st.config ? Promise.resolve(st.config) : chain.getConfig(),
        loadRoster(stats),
        olderMayBeOpen ? chain.getOpenTickets() : Promise.resolve(null),
      ]);
      st.config = config;
      const have = new Set((recent || []).map((t) => t.id));
      const older = (openNow || []).filter((t) => !have.has(t.id)).sort((a, b) => a.id - b.id);
      const all = [...older, ...(recent || [])];
      const open = all.filter((t) => t.state === 'open').sort((a, b) => Number(a.deadline_ms) - Number(b.deadline_ms));
      const g = chain.guest();
      let d = null;
      const stmts = {};
      if (g?.created) {
        d = await chain.getDesk(g.accountId);
        if (d?.registered) {
          markRegistered(chain.network, chain.contractId);
          const ids = all.map((t) => t.id);
          const list = await chain.getStatements(g.accountId, ids);
          ids.forEach((id, i) => {
            if (list[i]) stmts[id] = list[i];
          });
        }
      }
      const chainStatements = { ...stmts };
      // Answers filed this session stay on screen until a read confirms them (RPC nodes lag a little).
      const nowMs = Date.now();
      for (const [id, p] of Object.entries(st.pending)) {
        if (stmts[id]?.status === p.statement.status || p.until < nowMs) delete st.pending[id];
        else if (d?.registered) stmts[id] = p.statement;
      }
      let demoNext = null;
      const dsig = demoSigOf(stats);
      if (opts.forceDemo || dsig !== st.demoSig) {
        const list = chain.demoAccounts || DEMO_ACCOUNTS;
        const desks = await Promise.all(list.map((a) => chain.getDesk(a.id).catch(() => null)));
        demoNext = list.map((a, i) => ({ ...a, desk: desks[i] }));
        st.demoSig = dsig;
      }
      st.sig = sigOf(stats);
      st.loaded = true;
      if (demoNext) setDemo(demoNext);
      setData({ stats, open, all, config, loaded: true });
      setGuest(chain.guest());
      setDesk(d);
      setStatements(stmts);
      succeeded();
      return { stats, open, all, desk: d, statements: stmts, chainStatements };
    },
    [chain, succeeded, loadRoster],
  );

  // Coalesced: a reload requested while one runs is folded into a single follow-up reload.
  const refresh = useCallback(
    (opts = {}) => {
      if (!chain) return Promise.resolve(null);
      const st = S.current;
      if (st.running) {
        st.again = { ...(st.again || {}), ...opts, stats: undefined };
        return st.running.then(() => st.followUp || null);
      }
      const run = load(opts)
        .catch((e) => {
          failed(e, () => refresh({ forceDemo: !st.loaded }));
          return null;
        })
        .finally(() => {
          st.running = null;
          if (st.again) {
            const a = st.again;
            st.again = null;
            st.followUp = refresh(a);
          } else st.followUp = null;
        });
      st.running = run;
      return run;
    },
    [chain, load, failed],
  );

  // Keep reloading until the change a write made is visible, for up to about 20 s.
  const refreshUntil = useCallback(
    async (done, ms = 20_000) => {
      const end = Date.now() + ms;
      for (;;) {
        let snap = await refresh({});
        if (snap && !done(snap)) snap = null;
        if (snap) return snap;
        if (Date.now() > end) return null;
        await sleep(1500);
      }
    },
    [refresh],
  );

  const tick = useCallback(async () => {
    const st = S.current;
    if (!chain || document.hidden || st.running || st.ticking) return;
    st.ticking = true;
    try {
      const stats = await chain.getStats();
      succeeded();
      if (sigOf(stats) !== st.sig || !st.loaded) refresh({ stats, forceDemo: !st.loaded });
      else {
        setData((x) => ({ ...x, stats }));
        if (st.rosterStale) loadRoster(stats);
      }
    } catch (e) {
      failed(e, tick);
    } finally {
      st.ticking = false;
    }
  }, [chain, refresh, succeeded, failed, loadRoster]);

  // First load, the tick, and a reload whenever the tab comes back.
  useEffect(() => {
    if (!chain) return undefined;
    setGuest(chain.guest());
    refresh({ forceDemo: true });
    const t = setInterval(tick, REFRESH_MS[deskKey]);
    const onVis = () => {
      if (!document.hidden) refresh({ forceDemo: true });
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clearInterval(t);
      clearTimeout(S.current.retry);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [chain, deskKey, refresh, tick]);

  // One reload about 2 s after each open ticket's deadline (on the chain's clock).
  useEffect(() => {
    if (!chain) return undefined;
    const timers = data.open
      .map((t) => Number(t.deadline_ms) - chain.now() + 2000)
      .filter((ms) => ms > 0 && ms < 86_400_000)
      .map((ms) => setTimeout(() => refresh({}), ms));
    return () => timers.forEach(clearTimeout);
  }, [chain, data.open, refresh]);

  const notePending = useCallback((ticketId, statement) => {
    S.current.pending[ticketId] = { statement, until: Date.now() + 25_000 };
  }, []);

  return { data, guest, setGuest, desk, setDesk, statements, setStatements, demo, roster, error, trouble, refresh, refreshUntil, notePending };
}
