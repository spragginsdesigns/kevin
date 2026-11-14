import { useEffect, useId, useState } from 'react';
import { CISA_SEARCH_URL, NVD_URL } from '../config.js';
import { countdown, countdownWords, fmtInt, STATUS_LABEL, STATUSES, ticketNo, utcStamp } from '../format.js';
import { kevLocal, kevLookup } from '../kev.js';
import { deskVerdict, ticketNote } from '../kevinSays.js';
import { Stamp } from './Stamp.jsx';

const pct = (bps) => `${(bps / 100).toFixed(bps % 100 ? 1 : 0)}%`;

export function Ticket({ ticket: t, now, statement, busy, fresh, desk, drill, settling, onAnswer, onNeedPager }) {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const c = countdown(t.deadline_ms, now);
  const lapsed = c.over;
  const onCall = Boolean(desk?.on_call);
  // Only an on-call desk is liable, and only for deadlines that came while it was on call.
  const verdict = lapsed ? deskVerdict(desk, t, statement) : null;
  const missed = verdict === 'missed';
  const local = kevLocal(t.cve_id);
  // The replayed desks (fire drill, demo chain) run on their own clock; show CISA's own date too.
  const replayed = drill || new Date(Number(t.deadline_ms)).toISOString().slice(0, 10) !== t.due_date;
  const status = statement?.status;
  const total = t.not_affected + t.fixed + t.mitigated;

  return (
    <article
      className={`ticket ${t.ransomware ? 'is-ransom' : ''} ${status ? 'is-answered' : ''} ${lapsed ? 'is-lapsed' : ''} ${missed ? 'is-missed' : ''} ${c.urgent && !lapsed ? 'is-urgent' : ''}`}
      aria-labelledby={`${detailsId}-h`}
    >
      <div className="stub">
        <div className="stub-row">
          <span className="stub-label">Ticket</span>
          <span className="stub-no">No. {ticketNo(t.id)}</span>
        </div>
        <div className="stub-clock">
          <span className="stub-label">{lapsed ? 'Deadline' : 'Time left'}</span>
          <span className="countdown" aria-hidden="true">
            {lapsed ? 'PASSED' : c.text}
          </span>
          <span className="sr-only">{countdownWords(t.deadline_ms, now)}</span>
        </div>
        <div className="stub-due">
          <span className="stub-label">Due</span>
          <time dateTime={new Date(Number(t.deadline_ms)).toISOString()}>{utcStamp(t.deadline_ms)}</time>
        </div>
        <p className="stub-note">
          <span className="stub-label">Kevin</span>
          <span className="stub-note-text">{ticketNote(t, now, { unsettled: settling })}</span>
        </p>
      </div>

      <div className="body">
        <div className="body-top">
          <span className="cve">{t.cve_id}</span>
          <span className={`rate ${t.ransomware ? 'rate-ransom' : ''}`}>
            {t.ransomware ? `Ransomware: ${pct(t.burn_bps)} burn` : `Standard: ${pct(t.burn_bps)} burn`}
          </span>
          {/* Stamps live here: on desktop they are positioned over the stub; at phone width they
              sit in this row's free space, so they never cover text. */}
          {t.ransomware && <Stamp kind="ransom" label="Ransomware" small />}
          {status && <Stamp kind="answered" label="Answered" fresh={fresh} />}
          {missed && <Stamp kind="overdue" label="Overdue" fresh />}
        </div>
        <h3 className="product" id={`${detailsId}-h`}>
          <span className="vendor">{t.vendor}</span>
          <span className="product-name">{t.product}</span>
        </h3>
        {local?.vulnerabilityName && <p className="vname">{local.vulnerabilityName}</p>}

        <dl className="facts">
          <div>
            <dt>CISA added</dt>
            <dd>{t.date_added}</dd>
          </div>
          {replayed && (
            <div>
              <dt>Original CISA due</dt>
              <dd>{t.due_date}</dd>
            </div>
          )}
          <div className="facts-answers">
            <dt>Answered</dt>
            <dd>
              {fmtInt(t.closes)} {t.closes === 1 ? 'account' : 'accounts'}
              <Split t={t} total={total} />
            </dd>
          </div>
        </dl>

        <div className="answer">
          <div className="answer-mine">
            <span className="answer-label">Your statement</span>
            <span className={`answer-value ${status ? 'has' : ''} ${lapsed && !status && !missed ? 'neutral' : ''}`}>
              {status
                ? STATUS_LABEL[status]
                : missed
                  ? 'None: missed'
                  : lapsed
                    ? { not_on_call: 'Not on call then', no_answer: 'No answer' }[verdict] || 'Deadline passed'
                    : 'OPEN'}
            </span>
          </div>
          {onCall || lapsed ? (
            <div className="answer-buttons" role="group" aria-label={`Answer ${t.cve_id}`}>
              {STATUSES.map((s) => (
                <button
                  key={s}
                  type="button"
                  className={`btn btn-answer ${status === s ? 'is-picked' : ''}`}
                  aria-pressed={status === s}
                  disabled={lapsed || Boolean(busy)}
                  onClick={() => onAnswer(t, s)}
                >
                  {busy === s ? 'Filing...' : STATUS_LABEL[s]}
                </button>
              ))}
            </div>
          ) : (
            <button type="button" className="btn btn-ghost btn-pager" onClick={onNeedPager}>
              Take the pager to answer
            </button>
          )}
          {!lapsed && <p className="answer-hint">{onCall ? 'Answers count only before the deadline.' : 'Only desks on call answer. Holding KEVIN asks nothing.'}</p>}
        </div>

        <button type="button" className="disclose" aria-expanded={open} aria-controls={`${detailsId}-d`} onClick={() => setOpen((o) => !o)}>
          {open ? 'Hide CISA notes' : 'CISA notes and required action'}
        </button>
        {open && <Details id={`${detailsId}-d`} cve={t.cve_id} />}
      </div>

    </article>
  );
}

function Split({ t, total }) {
  if (!total) return <span className="split-empty">No answers yet</span>;
  const parts = [
    ['not_affected', t.not_affected],
    ['fixed', t.fixed],
    ['mitigated', t.mitigated],
  ];
  return (
    <span className="split">
      <span className="split-bar" aria-hidden="true">
        {parts.map(([k, n]) => (n ? <span key={k} className={`split-${k}`} style={{ flexGrow: n }} /> : null))}
      </span>
      <span className="split-legend">
        {parts.map(([k, n]) => (
          <span key={k} className={`split-key split-key-${k}`}>
            {STATUS_LABEL[k]} {fmtInt(n)}
          </span>
        ))}
      </span>
    </span>
  );
}

function Details({ id, cve }) {
  const [state, setState] = useState(() => {
    const e = kevLocal(cve);
    return e ? { entry: e, source: 'snapshot' } : { loading: true };
  });
  useEffect(() => {
    if (state.entry) return undefined;
    let live = true;
    kevLookup(cve)
      .then((r) => live && setState(r.entry ? r : { missing: true }))
      .catch(() => live && setState({ failed: true }));
    return () => {
      live = false;
    };
  }, [cve, state.entry]);

  return (
    <div className="details" id={id}>
      {state.loading && <p className="details-note">Looking up {cve} in the CISA catalog...</p>}
      {state.failed && <p className="details-note">Could not load the CISA entry right now. The links below still work.</p>}
      {state.missing && <p className="details-note">{cve} is not in the catalog snapshot or the live mirror.</p>}
      {state.entry && (
        <>
          <h4>What CISA says</h4>
          <p>{state.entry.shortDescription}</p>
          <h4>Required action</h4>
          <p>{state.entry.requiredAction}</p>
          {state.source === 'mirror' && <p className="details-note">From the live cisagov/kev-data mirror (newer than the bundled snapshot).</p>}
        </>
      )}
      <p className="details-links">
        <a href={CISA_SEARCH_URL(cve)} target="_blank" rel="noreferrer">
          CISA KEV entry
        </a>
        <a href={NVD_URL(cve)} target="_blank" rel="noreferrer">
          NVD record
        </a>
      </p>
    </div>
  );
}
