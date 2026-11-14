import { TOKEN_SYMBOL } from '../config.js';
import { fmtInt, fmtToken } from '../format.js';

// Two always-on demo desks read from chain with get_desk: one on-call desk that answers everything
// and one that never does. Side by side, they show what the burn rule does to a committed stake.
export function DemoDesks({ accounts, loaded }) {
  if (!loaded || !accounts.length) return null;
  const shown = accounts.filter((a) => a.desk?.registered);
  if (!shown.length) return null;
  return (
    <section className="demo-desks" aria-label="Two demo desks">
      {shown.map((a) => (
        <div key={a.id} className={`demo-desk ${Number(a.desk.missed) ? 'is-missing' : 'is-answering'}`}>
          <div className="demo-who">
            <span className="demo-label">{a.label}</span>
            <span className="demo-id mono">{a.id}</span>
          </div>
          <dl className="demo-nums">
            <div>
              <dt>Committed</dt>
              <dd>
                {a.desk.on_call ? (
                  <>
                    {fmtToken(a.desk.committed, { decimals: 2 })} <span className="demo-unit">{TOKEN_SYMBOL}</span>
                  </>
                ) : (
                  <span className="demo-unit">not on call</span>
                )}
              </dd>
            </div>
            <div>
              <dt>Missed</dt>
              <dd className={Number(a.desk.missed) ? 'bad' : ''}>{fmtInt(a.desk.missed)}</dd>
            </div>
          </dl>
        </div>
      ))}
    </section>
  );
}
