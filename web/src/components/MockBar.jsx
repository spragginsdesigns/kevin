import { useState } from 'react';

// Visible only with ?mock=1. Moves the in-memory chain's clock so deadlines, expiry, pending burns,
// Settle and the end of a shift can be exercised without waiting for CISA's real dates.
export function MockBar({ chain, onChange, desk }) {
  const [, force] = useState(0);
  const skew = chain.now() - Date.now();
  const mins = Math.round(skew / 60000);
  const label = mins === 0 ? 'real time' : mins < 120 ? `+${mins} min` : `+${(mins / 1440).toFixed(1)} days`;
  const run = (fn) => {
    fn();
    window.dispatchEvent(new Event('kevin:clock'));
    force((n) => n + 1);
    onChange();
  };
  return (
    <div className="mockbar" role="region" aria-label="Demo chain controls">
      <span className="mockbar-tag">DEMO CHAIN</span>
      <span className="mockbar-text">In-memory contract, simulated holders, clock {label}.</span>
      <span className="mockbar-actions">
        <button type="button" className="btn btn-small" onClick={() => run(() => chain.skipToNextDeadline())} data-mock="skip">
          Jump past next deadline
        </button>
        {desk?.on_call && Number(desk.shift_ends_ms) > chain.now() && (
          <button type="button" className="btn btn-small" onClick={() => run(() => chain.skipToShiftEnd())} data-mock="shift">
            Jump to the end of my shift
          </button>
        )}
        <button
          type="button"
          className="btn btn-small btn-ghost"
          onClick={() => {
            chain.reset();
            chain.forgetGuest();
            location.reload();
          }}
        >
          Reset demo
        </button>
      </span>
    </div>
  );
}
