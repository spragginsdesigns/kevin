import { useState } from 'react';
import { TOKEN_SYMBOL } from '../config.js';
import { fmtInt, fmtToken, STATUS_LABEL, ticketNo, utcStamp } from '../format.js';
import { deskVerdict, ticketNote } from '../kevinSays.js';

const PAGE = 12;

export function PastTickets({ tickets, now, loaded, statements, desk, drill, settling }) {
  const [shown, setShown] = useState(PAGE);
  const past = tickets
    .filter((t) => t.state === 'expired' || Number(t.deadline_ms) <= now)
    .sort((a, b) => Number(b.deadline_ms) - Number(a.deadline_ms));
  const totalBurn = past.reduce((s, t) => s + BigInt(t.burned), 0n);
  const totalMissed = past.reduce((s, t) => s + t.missed, 0);

  const mine = (t) => {
    if (!desk?.registered) return null;
    const st = statements[t.id];
    if (st) return { kind: 'ok', text: STATUS_LABEL[st.status] };
    // Only an on-call desk is liable, and only for deadlines that came while it was on call.
    const v = deskVerdict(desk, t, st);
    if (v === 'missed') return { kind: 'miss', text: 'Missed' };
    return { kind: 'na', text: v === 'no_answer' ? 'No answer' : 'Not on call' };
  };

  return (
    <section className="past" aria-labelledby="past-h">
      <div className="section-head">
        <h2 id="past-h">Past tickets</h2>
        <p className="section-sub">
          {past.length
            ? `${fmtInt(past.length)} closed by the clock. ${fmtInt(totalMissed)} silent on-call desks, ${fmtToken(totalBurn)} ${TOKEN_SYMBOL} burned from what they committed.`
            : loaded
              ? 'No ticket has reached its deadline yet.'
              : 'Loading...'}
        </p>
      </div>
      {past.length > 0 && (
        <div className="ledger" role="table" aria-label="Expired tickets">
          <div className="ledger-row ledger-head" role="row">
            <span role="columnheader">No.</span>
            <span role="columnheader">CVE and product</span>
            <span role="columnheader">Deadline</span>
            <span role="columnheader" className="num">Answered</span>
            <span role="columnheader" className="num">Missed</span>
            <span role="columnheader" className="num">Burned</span>
            {desk?.registered && <span role="columnheader">You</span>}
          </div>
          {past.slice(0, shown).map((t) => {
            const m = mine(t);
            return (
              <div className={`ledger-row ${t.ransomware ? 'is-ransom' : ''}`} role="row" key={t.id}>
                <span role="cell" className="mono ledger-no">
                  {ticketNo(t.id)}
                </span>
                <span role="cell" className="ledger-what">
                  <span className="mono">{t.cve_id}</span>
                  {t.ransomware && <span className="rate rate-ransom rate-mini">Ransomware {t.burn_bps / 100}%</span>}
                  <span className="ledger-product">
                    {t.vendor} {t.product}
                  </span>
                  <span className="ledger-note">Kevin: {ticketNote(t, now, { unsettled: settling })}</span>
                </span>
                <span role="cell" className="mono ledger-date" data-label="Deadline">
                  {drill ? utcStamp(t.deadline_ms).slice(11) : t.due_date}
                </span>
                <span role="cell" className="num" data-label="Answered">
                  {fmtInt(t.closes)}
                </span>
                <span role="cell" className="num" data-label="Missed">
                  {fmtInt(t.missed)}
                </span>
                <span role="cell" className="num burn" data-label="Burned">
                  {fmtToken(t.burned)}
                </span>
                {desk?.registered && (
                  <span role="cell" data-label="You" className={`mine mine-${m.kind}`}>
                    {m.text}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
      {past.length > shown && (
        <button type="button" className="btn btn-ghost more" onClick={() => setShown((n) => n + PAGE)}>
          Show {Math.min(PAGE, past.length - shown)} more
        </button>
      )}
    </section>
  );
}
