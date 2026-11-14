import { useState } from 'react';
import { EXPLORER_ACCOUNT, TOKEN_SYMBOL } from '../config.js';
import { fmtInt, fmtToken, shortAccount } from '../format.js';
import { EOTM } from '../kevinSays.js';
import { orderRoster, plaqueFor } from '../roster.js';
import { titleFor } from '../titles.js';

const PAGE = 25;

// The public leaderboard, read from get_roster alone and ordered on the client (roster.js).
export function EmployeeOfTheMonth({ roster, now, guestId, mock, pageError, contractId }) {
  const [shown, setShown] = useState(PAGE);
  const rows = orderRoster(roster.entries);
  const plaque = plaqueFor(rows);
  const link = (a) => (mock ? undefined : `${EXPLORER_ACCOUNT}${a}`);

  let body;
  if (!roster.loaded && !pageError) {
    body = <p className="notice notice-empty eotm-state">Reading the roster...</p>;
  } else if (!rows.length && (roster.error || pageError)) {
    const missing = (roster.error || pageError) === 'missing';
    body = (
      <div className="notice notice-error eotm-state" role="alert">
        <p className="notice-title">{missing ? 'No roster to read yet.' : 'The roster could not be loaded.'}</p>
        <p>
          {missing ? (
            <>
              The roster lives on the desk contract, and <code>{contractId}</code> was not found on NEAR testnet.
            </>
          ) : (
            roster.error || pageError
          )}
        </p>
      </div>
    );
  } else if (!rows.length) {
    body = (
      <div className="notice notice-empty eotm-state">
        <p>{EOTM.empty}</p>
      </div>
    );
  } else {
    body = (
      <>
        {plaque && <Plaque entry={plaque} href={link(plaque.account_id)} you={plaque.account_id === guestId} />}
        <div className="roster" role="table" aria-label="Roster, this month">
          <div className="roster-row roster-head" role="row">
            <span role="columnheader">Place</span>
            <span role="columnheader">Desk</span>
            <span role="columnheader">Title</span>
            <span role="columnheader" className="num">
              On time
            </span>
            <span role="columnheader" className="num">
              Streak
            </span>
            <span role="columnheader" className="num">
              Ignored
            </span>
            <span role="columnheader" className="num">
              Burned
            </span>
            <span role="columnheader" className="num">
              Committed now
            </span>
          </div>
          {rows.slice(0, shown).map((e, i) => {
            const d = e.desk;
            const you = e.account_id === guestId;
            return (
              <div className={`roster-row ${you ? 'is-you' : ''} ${d.on_call ? '' : 'is-out'}`} role="row" key={e.account_id}>
                <span role="cell" className="roster-place mono">
                  {i + 1}
                </span>
                <span role="cell" className="roster-who">
                  <a className="roster-account mono" href={link(e.account_id)} target="_blank" rel="noreferrer" title={e.account_id}>
                    {shortAccount(e.account_id)}
                    {!mock && <span className="sr-only"> (opens the explorer in a new tab)</span>}
                  </a>
                  {you && <span className="roster-you">You</span>}
                  <span className="roster-life">
                    Lifetime: {fmtInt(d.on_time)} on time, {fmtInt(d.missed)} missed, best streak {fmtInt(d.best_streak)},{' '}
                    {fmtToken(d.burned)} {TOKEN_SYMBOL} burned
                  </span>
                </span>
                <span role="cell" className="roster-title" data-label="Title">
                  {titleFor(d)}
                </span>
                <span role="cell" className="num" data-label="On time, this month">
                  {fmtInt(d.month_on_time)}
                </span>
                <span role="cell" className="num" data-label="Streak">
                  {fmtInt(d.streak)}
                </span>
                <span role="cell" className={`num ${Number(d.month_missed) ? 'burn' : ''}`} data-label="Ignored, this month">
                  {fmtInt(d.month_missed)}
                </span>
                <span role="cell" className={`num ${BigInt(d.month_burned || 0) > 0n ? 'burn' : ''}`} data-label={`Burned, this month (${TOKEN_SYMBOL})`}>
                  {fmtToken(d.month_burned)}
                </span>
                <span role="cell" className="num roster-committed" data-label="Committed now">
                  {d.on_call ? `${fmtToken(d.committed)} ${TOKEN_SYMBOL}` : 'clocked out'}
                </span>
              </div>
            );
          })}
        </div>
        {rows.length > shown && (
          <button type="button" className="btn btn-ghost more" onClick={() => setShown((n) => n + PAGE)}>
            Show {Math.min(PAGE, rows.length - shown)} more
          </button>
        )}
        {roster.error && (
          <p className="rpc-trouble" role="status">
            Could not refresh the roster ({roster.error}). Showing the last one read.
          </p>
        )}
      </>
    );
  }

  return (
    <section className="eotm" aria-labelledby="eotm-h">
      <div className="section-head">
        <h2 id="eotm-h">{EOTM.heading(now)}</h2>
        <p className="section-sub">Every desk that has taken the pager. Streak counts consecutive deadlines met; on time, ignored and burned count this month (UTC).</p>
      </div>
      <p className="eotm-note">{EOTM.note}</p>
      {body}
    </section>
  );
}

function Plaque({ entry, href, you }) {
  const d = entry.desk;
  return (
    <figure className="plaque">
      <p className="plaque-label">Employee of the Month</p>
      <p className="plaque-name mono">
        <a href={href} target="_blank" rel="noreferrer">
          {entry.account_id}
        </a>
        {you && <span className="roster-you">You</span>}
      </p>
      <p className="plaque-title">{titleFor(d)}</p>
      <figcaption className="plaque-line">
        {fmtInt(d.month_on_time)} answered on time this month. Streak {fmtInt(d.streak)}.
      </figcaption>
    </figure>
  );
}
