import { DRILL_SCHEDULE } from '../config.js';
import { countdown } from '../format.js';
import { Ticket } from './Ticket.jsx';

const LAPSE_SHOWN_MS = 30 * 60_000;

export function Queue({ tickets, all = tickets, loaded, error, now, statements, busy, fresh, desk, drill, contractId, onAnswer, onNeedPager, onRetry, settling }) {
  const open = tickets.filter((t) => Number(t.deadline_ms) > now);
  // A ticket whose deadline just passed stays in the queue for a while, stamped OVERDUE, so the
  // flip is visible; after that it lives only under Past tickets.
  const lapsing = all.filter((t) => Number(t.deadline_ms) <= now && now - Number(t.deadline_ms) < LAPSE_SHOWN_MS);
  const answered = open.filter((t) => statements[t.id]).length;

  return (
    <section className="queue" id="queue" aria-labelledby="queue-h">
      <div className="section-head">
        <h2 id="queue-h">The queue</h2>
        <p className="section-sub">
          {loaded && !error
            ? open.length
              ? `${open.length} open, soonest deadline first.${desk?.on_call ? ` You have answered ${answered} of ${open.length}.` : ''}`
              : 'No open tickets.'
            : 'Open tickets, soonest deadline first.'}
        </p>
      </div>

      {!loaded && (
        <div className="ticket-skeletons" aria-label="Loading tickets">
          {[0, 1, 2].map((i) => (
            <div key={i} className="ticket ticket-skeleton" aria-hidden="true">
              <div className="stub" />
              <div className="body" />
            </div>
          ))}
        </div>
      )}

      {loaded && error && (
        <div className="notice notice-error" role="alert">
          {error === 'missing' ? (
            <>
              <p className="notice-title">This desk is not open yet.</p>
              <p>
                The contract <code>{contractId}</code> was not found on NEAR testnet. It may not be deployed yet.
              </p>
            </>
          ) : (
            <>
              <p className="notice-title">The queue could not be loaded.</p>
              <p>{error}</p>
            </>
          )}
          <div className="notice-actions">
            <button type="button" className="btn btn-ink" onClick={onRetry}>
              Try again
            </button>
            <a className="btn btn-ghost" href={drill ? '?mock=1&desk=drill' : '?mock=1'}>
              Open the demo desk instead
            </a>
          </div>
        </div>
      )}

      {loaded && !error && drill && open.length === 0 && <NextDrill now={now} />}

      {loaded && !error && !drill && open.length === 0 && lapsing.length === 0 && (
        <div className="notice notice-empty">
          <p className="notice-title">Inbox zero.</p>
          <p>
            Nothing is due. A new ticket opens when CISA adds a bug to the catalog and the reporters confirm
            it.
          </p>
        </div>
      )}

      <ol className="tickets">
        {[...open, ...lapsing].map((t) => (
          <li key={t.id}>
            <Ticket
              ticket={t}
              now={now}
              statement={statements[t.id]}
              busy={busy[t.id]}
              fresh={fresh[t.id]}
              desk={desk}
              drill={drill}
              settling={settling}
              onAnswer={onAnswer}
              onNeedPager={onNeedPager}
            />
          </li>
        ))}
      </ol>
    </section>
  );
}

// The drill desk opens a ticket every quarter hour (UTC); between tickets, count down to the next one.
function NextDrill({ now }) {
  const step = DRILL_SCHEDULE.everyMinutes * 60_000;
  const next = Math.ceil((now + 1) / step) * step;
  const ended = now > Date.parse(`${DRILL_SCHEDULE.lastDayUtc}T23:59:59Z`);
  if (ended) {
    return (
      <div className="notice notice-empty">
        <p className="notice-title">The fire drill is over.</p>
        <p>The drill schedule ran through {DRILL_SCHEDULE.lastDayUtc}. Its past tickets and burns stay on the record below.</p>
      </div>
    );
  }
  const c = countdown(next, now);
  const at = new Date(next).toISOString().slice(11, 16);
  return (
    <div className="notice notice-empty next-drill">
      <p className="notice-title">No drill ticket is open right now.</p>
      <p className="next-drill-clock">
        <span className="stub-label">Next drill ticket at {at} UTC</span>
        <span className="countdown" aria-hidden="true">
          {c.text}
        </span>
        <span className="sr-only">opens in {c.m} minutes {c.s} seconds</span>
      </p>
      <p>{DRILL_SCHEDULE.text}</p>
    </div>
  );
}
