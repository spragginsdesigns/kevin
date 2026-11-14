import { EXPLORER_TX } from '../config.js';

// A link to a write's transaction on the testnet explorer. The demo chain has no transactions,
// so it gets a plain label instead of a link that would go nowhere.
export function TxLink({ tx, label = 'View transaction' }) {
  if (!tx) return null;
  if (tx.demo || !tx.hash) return <span className="txlink txlink-demo">demo chain, no transaction</span>;
  return (
    <a className="txlink" href={`${EXPLORER_TX}${tx.hash}`} target="_blank" rel="noreferrer">
      {label}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

export const txOf = (r) => (r ? { hash: r.txHash || null, demo: Boolean(r.demo) || !r.txHash } : null);
