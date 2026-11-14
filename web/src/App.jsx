import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DRILL_SCHEDULE } from './config.js';
import { readSelection, openChain } from './desk.js';
import { explainError } from './errors.js';
import { big } from './format.js';
import { markRegistered, isRegisteredHint } from './guest.js';
import { Masthead } from './components/Masthead.jsx';
import { Queue } from './components/Queue.jsx';
import { PastTickets } from './components/PastTickets.jsx';
import { MyDesk } from './components/MyDesk.jsx';
import { SimChart } from './components/SimChart.jsx';
import { Footer } from './components/Footer.jsx';
import { MockBar } from './components/MockBar.jsx';
import { DemoDesks } from './components/DemoDesks.jsx';
import { EmployeeOfTheMonth } from './components/EmployeeOfTheMonth.jsx';
import { ACTION_LINES, rosterUnsettled } from './kevinSays.js';
import { TxLink, txOf } from './components/TxLink.jsx';
import { useNow } from './useNow.js';
import { useDeskData } from './useDeskData.js';

const selection = readSelection();

export function App() {
  const [chain, setChain] = useState(null);
  const [openError, setOpenError] = useState(null);
  const [busy, setBusy] = useState({});
  const [fresh, setFresh] = useState({}); // ticket ids answered this session, for the stamp motion
  const [toast, setToast] = useState(null);
  const [onboard, setOnboard] = useState({ phase: 'idle', step: null, error: null });
  const [lastTx, setLastTx] = useState(null);
  const deskRef = useRef(null);
  const now = useNow(chain);
  const { data, guest, setGuest, desk, setDesk, statements, setStatements, demo, roster, error: loadError, trouble, refresh, refreshUntil, notePending } =
    useDeskData(chain, selection.deskKey);
  const error = openError || loadError;

  useEffect(() => {
    let live = true;
    openChain(selection)
      .then((c) => live && setChain(c))
      .catch((e) => setOpenError(explainError(e)));
    return () => {
      live = false;
    };
  }, []);

  // Every successful write ends here: a toast (with its transaction link) and the desk's last-transaction line.
  const say = useCallback((text, tone = 'info', result = null) => {
    const tx = txOf(result);
    if (tx) setLastTx({ ...tx, what: text });
    setToast({ text, tone, tx, id: Date.now() });
  }, []);
  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), toast.tx ? 9000 : 5000);
    return () => clearTimeout(t);
  }, [toast]);

  const registered = Boolean(desk?.registered);

  const openGuestDesk = useCallback(async () => {
    if (!chain) return;
    setOnboard({ phase: 'running', step: 'key', error: null });
    try {
      let g = chain.guest();
      if (!g?.created) g = await chain.createGuest((step) => setOnboard((o) => ({ ...o, step })));
      setGuest(g);
      setOnboard((o) => ({ ...o, step: 'bounds' }));
      const reg = await chain.register((step) => setOnboard((o) => ({ ...o, step })));
      markRegistered(chain.network, chain.contractId);
      say(`Desk open. ${g.accountId} holds the starter bag and is not on call.`, 'good', reg);
      await refreshUntil((snap) => snap.desk?.registered);
      setOnboard({ phase: 'done', step: 'done', error: null });
    } catch (e) {
      setOnboard((o) => ({ phase: 'error', step: o.step, error: explainError(e), code: e.code }));
      setGuest(chain.guest());
    }
  }, [chain, refreshUntil, say, setGuest]);

  const onCall = Boolean(desk?.on_call);

  // Answers need a desk on call: send the person to My Desk, where the next step is waiting.
  const needPager = useCallback(() => {
    say(registered ? 'Take the pager to answer: My desk, then Take the pager.' : 'Open a guest desk first, then take the pager to answer.', 'warn');
    deskRef.current?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    setTimeout(() => deskRef.current?.querySelector('[data-primary]')?.focus({ preventScroll: true }), 350);
  }, [registered, say]);

  const answer = useCallback(
    async (ticket, status) => {
      if (!onCall) return needPager();
      setBusy((b) => ({ ...b, [ticket.id]: status }));
      try {
        const r = await chain.closeTicket(ticket.id, status);
        const first = !statements[ticket.id];
        const st = r.value || { status, at_ms: String(chain.now()) };
        notePending(ticket.id, st);
        setStatements((s) => ({ ...s, [ticket.id]: st }));
        if (first) setFresh((f) => ({ ...f, [ticket.id]: Date.now() }));
        say(first ? `${ticket.cve_id}: ${ACTION_LINES.answered}` : `${ticket.cve_id} statement changed.`, 'good', r);
        refreshUntil((snap) => snap.chainStatements[ticket.id]?.status === status);
      } catch (e) {
        say(explainError(e), 'bad');
        refresh({});
      } finally {
        setBusy((b) => {
          const n = { ...b };
          delete n[ticket.id];
          return n;
        });
      }
    },
    [chain, onCall, needPager, statements, refresh, refreshUntil, notePending, say, setStatements],
  );

  const actions = useMemo(
    () => ({
      // Settle, then keep reading until the burn shows (pending burn 0) and the supply line moved with it.
      async settle() {
        const r = await chain.settle(guest.accountId);
        await refreshUntil((snap) => big(snap.desk?.pending_burn) === 0n);
        return r;
      },
      async transfer(to, amount) {
        const before = desk?.balance;
        const r = await chain.transfer(to, amount);
        await refreshUntil((snap) => snap.desk?.balance !== before);
        return r;
      },
      // Take the pager, or add to the commitment when already on call.
      async goOnCall(amount) {
        const before = desk?.stored_committed;
        const r = await chain.goOnCall(amount);
        await refreshUntil((snap) => snap.desk?.on_call && snap.desk.stored_committed !== before);
        return r;
      },
      async clockOut() {
        const r = await chain.clockOut();
        await refreshUntil((snap) => snap.desk && !snap.desk.on_call);
        return r;
      },
      addOncallKey: () => chain.addOncallKey(),
      forget() {
        chain.forgetGuest();
        setGuest(null);
        setDesk(null);
        setStatements({});
        setOnboard({ phase: 'idle', step: null, error: null });
      },
    }),
    [chain, guest, desk, refreshUntil, setGuest, setDesk, setStatements],
  );

  const tone = selection.deskKey === 'drill' ? 'drill' : 'live';
  const hint = guest && isRegisteredHint(guest, selection.desk.contractId);

  return (
    <div className={`page desk-${tone}`}>
      <a className="skip" href="#queue">Skip to the queue</a>
      {selection.deskKey === 'drill' && (
        <div className="drill-banner" role="note">
          <p>
            <strong>FIRE DRILL:</strong> real CISA entries from the past, replayed on a fast clock. Deadlines here are minutes away.
          </p>
          <p className="drill-banner-sub">{DRILL_SCHEDULE.text}</p>
        </div>
      )}
      {chain?.mock && <MockBar chain={chain} desk={desk} onChange={() => refresh({ forceDemo: true })} />}
      <Masthead
        selection={selection}
        stats={data.stats}
        loaded={data.loaded}
        error={error}
        guest={guest}
        desk={desk}
        tickets={data.all}
        now={now}
        roster={roster}
      />
      {trouble && data.loaded && (
        <p className="rpc-trouble" role="status">
          RPC is having trouble, retrying. Showing the last data read.
        </p>
      )}
      <main className="layout">
        <DemoDesks accounts={demo} loaded={data.loaded && !error} />
        <Queue
          tickets={data.open}
          all={data.all}
          loaded={data.loaded}
          error={error}
          now={now}
          statements={statements}
          busy={busy}
          fresh={fresh}
          desk={desk}
          drill={selection.deskKey === 'drill'}
          settling={rosterUnsettled(roster)}
          contractId={selection.desk.contractId}
          onAnswer={answer}
          onNeedPager={needPager}
          onRetry={() => refresh({ forceDemo: true })}
        />
        <MyDesk
          ref={deskRef}
          chain={chain}
          guest={guest}
          desk={desk}
          config={data.config}
          registeredHint={hint}
          onboard={onboard}
          onOpen={openGuestDesk}
          actions={actions}
          tickets={data.all}
          statements={statements}
          deskLabel={selection.desk.label}
          lastTx={lastTx}
          say={say}
          now={now}
          unavailable={Boolean(error)}
        />
      </main>
      <EmployeeOfTheMonth
        roster={roster}
        now={now}
        guestId={guest?.created ? guest.accountId : null}
        mock={Boolean(chain?.mock)}
        pageError={error}
        contractId={selection.desk.contractId}
      />
      <PastTickets
        tickets={data.all}
        now={now}
        loaded={data.loaded}
        statements={statements}
        desk={desk}
        drill={selection.deskKey === 'drill'}
        settling={rosterUnsettled(roster)}
      />
      <SimChart />
      <Footer />
      <div className={`toast ${toast ? `toast-${toast.tone}` : ''}`} role="status" aria-live="polite">
        {toast && (
          <span key={toast.id}>
            {toast.text}
            {toast.tx && (
              <>
                {' '}
                <TxLink tx={toast.tx} />
              </>
            )}
          </span>
        )}
      </div>
    </div>
  );
}
