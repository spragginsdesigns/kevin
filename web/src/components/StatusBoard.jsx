import { rosterUnsettled, statusBoard } from '../kevinSays.js';

// Kevin's status board, between the masthead and the supply line. Every line comes from kevinSays.js;
// this only lays it out. The countdown digits tick visually; screen readers get words instead, and
// nothing here is a live region, so the board is read once, in order, like the rest of the page.
export function StatusBoard({ stats, tickets, now, kind, roster, loaded, error, contractId }) {
  if (!loaded || (!stats && !error)) {
    return (
      <section className="board" aria-labelledby="board-h">
        <p className="board-label">KEVIN FROM IT</p>
        <h2 className="board-headline" id="board-h">
          Reading the queue...
        </h2>
        <p className="board-event">Kevin is opening his email. It takes a second.</p>
      </section>
    );
  }
  if (error && !stats) {
    return (
      <section className="board board-down" aria-labelledby="board-h">
        <p className="board-label">KEVIN FROM IT</p>
        <h2 className="board-headline" id="board-h">
          {error === 'missing' ? 'This desk is not open yet' : 'The queue could not be read'}
        </h2>
        <p className="board-event">
          {error === 'missing' ? (
            <>
              The contract <code>{contractId}</code> was not found on NEAR testnet. It may not be deployed yet.
            </>
          ) : (
            error
          )}
        </p>
      </section>
    );
  }
  // A ticket's `missed` counts only settled misses, so "everyone answered" waits while any on-call
  // desk still carries a pending burn.
  const unsettled = rosterUnsettled(roster);
  const b = statusBoard({ stats, tickets, now, kind, unsettled });
  return (
    <section className="board" aria-labelledby="board-h">
      <p className="board-label">{b.label}</p>
      <h2 className="board-headline" id="board-h">
        {b.headline}
      </h2>
      <blockquote className="board-quote">
        <p>"{b.quote}"</p>
      </blockquote>
      <p className="board-event">{b.event}</p>
      {b.next && (
        <p className="board-next">
          <span aria-hidden="true">{b.next.text}</span>
          <span className="sr-only">{b.next.spoken}</span>
        </p>
      )}
    </section>
  );
}
