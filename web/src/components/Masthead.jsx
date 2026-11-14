import { DESKS, TOKEN_SYMBOL } from '../config.js';
import { hrefFor } from '../desk.js';
import { fmtInt, fmtPct, fmtToken, shortAccount } from '../format.js';
import { AnimatedAmount } from './AnimatedAmount.jsx';
import { KevinPortrait } from './KevinPortrait.jsx';
import { StatusBoard } from './StatusBoard.jsx';

export function Masthead({ selection, stats, loaded, error, guest, desk, tickets, now, roster }) {
  const burned = stats?.burned_total;
  const initial = stats?.initial_supply;
  return (
    <header className="masthead">
      <div className="mast-top">
        <div className="mast-id">
          <KevinPortrait />
          <div className="mast-words">
            <p className="kicker">Service desk on NEAR testnet</p>
            <h1 className="title">
              <span className="title-kevin">KEVIN</span> <span className="title-from">from IT</span>
            </h1>
            <p className="lede">
              Every bug CISA adds to its Known Exploited Vulnerabilities catalog opens a ticket here, due on CISA's own
              deadline. Hold KEVIN and nothing is asked of you. Take the pager and you answer every ticket in time, or
              Kevin burns 1% of what you committed, 5% if the bug is used in ransomware.
            </p>
          </div>
        </div>
        <nav className="desk-switch" aria-label="Choose a desk">
          {Object.values(DESKS).map((d) => (
            <a
              key={d.key}
              href={hrefFor(d.key)}
              className={`desk-tab ${selection.deskKey === d.key ? 'is-on' : ''}`}
              aria-current={selection.deskKey === d.key ? 'page' : undefined}
            >
              <span className="desk-tab-label">{d.label}</span>
              <span className="desk-tab-id">{d.contractId}</span>
            </a>
          ))}
          <a className="desk-chip" href="#desk">
            <span className="desk-chip-label">Your desk</span>
            {guest?.created ? (
              <>
                <span className="desk-chip-id">{shortAccount(guest.accountId)}</span>
                {desk?.registered ? (
                  <span className="desk-chip-bal">
                    {desk.on_call ? `on call, ${fmtToken(desk.committed)} committed` : `${fmtToken(desk.balance)} ${TOKEN_SYMBOL}, not on call`}
                  </span>
                ) : (
                  <span className="desk-chip-bal">not registered here</span>
                )}
              </>
            ) : (
              <span className="desk-chip-id">Not open yet. Open one to answer.</span>
            )}
          </a>
        </nav>
      </div>

      <StatusBoard
        stats={stats}
        tickets={tickets}
        now={now}
        kind={selection.deskKey}
        roster={roster}
        loaded={loaded}
        error={error}
        contractId={selection.desk.contractId}
      />

      <section className="supply" aria-label="Live supply">
        <div className="supply-cell supply-main">
          <span className="supply-label">Total supply</span>
          <span className="supply-value">
            {stats ? <AnimatedAmount value={stats.total_supply} /> : <Placeholder loaded={loaded} error={error} />}
            <span className="supply-unit"> {TOKEN_SYMBOL}</span>
          </span>
        </div>
        <div className="supply-cell supply-burn">
          <span className="supply-label">Burned so far</span>
          <span className="supply-value">
            {stats ? <AnimatedAmount value={burned} rising /> : <Placeholder loaded={loaded} error={error} />}
          </span>
          {stats && <span className="supply-sub">{fmtPct(burned, initial)} of the initial {fmtToken(initial)}</span>}
        </div>
        <div className="supply-cell">
          <span className="supply-label">Open tickets</span>
          <span className="supply-value">{stats ? fmtInt(stats.tickets_open) : <Placeholder loaded={loaded} error={error} />}</span>
          {stats && <span className="supply-sub">{fmtInt(stats.tickets_expired)} closed by the clock</span>}
        </div>
        <div className="supply-cell supply-oncall">
          <span className="supply-label">On call</span>
          <span className="supply-value">{stats ? fmtInt(stats.on_call) : <Placeholder loaded={loaded} error={error} />}</span>
          {stats && (
            <span className="supply-sub">
              {Number(stats.on_call) === 1 ? 'desk' : 'desks'}, {fmtToken(stats.committed_total)} {TOKEN_SYMBOL} committed
            </span>
          )}
        </div>
        <div className="supply-cell">
          <span className="supply-label">Desks</span>
          <span className="supply-value">{stats ? fmtInt(stats.accounts) : <Placeholder loaded={loaded} error={error} />}</span>
          {stats && <span className="supply-sub">{fmtInt(stats.statements_total)} answers filed</span>}
        </div>
      </section>
    </header>
  );
}

function Placeholder({ loaded, error }) {
  if (loaded && error) return <span className="supply-na">n/a</span>;
  return <span className="shimmer" aria-label="Loading">--------</span>;
}
