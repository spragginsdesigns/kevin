// Which desk (live or fire drill) and which chain (real testnet or in-memory mock) this page uses.
// Both come from the URL so links and reloads keep them: ?desk=drill, ?mock=1.
import { DESKS } from './config.js';

export function readSelection() {
  const p = new URLSearchParams(location.search);
  const deskKey = p.get('desk') === 'drill' ? 'drill' : 'live';
  const mock = p.get('mock') === '1';
  return { deskKey, mock, desk: DESKS[deskKey] };
}

export function hrefFor(deskKey) {
  const p = new URLSearchParams(location.search);
  if (deskKey === 'drill') p.set('desk', 'drill');
  else p.delete('desk');
  const q = p.toString();
  return `${location.pathname}${q ? `?${q}` : ''}${location.hash}`;
}

export async function openChain({ deskKey, mock, desk }) {
  if (mock) {
    const { createMockChain } = await import('./mockChain.js');
    return createMockChain({ contractId: desk.contractId, deskKey });
  }
  const { createChain } = await import('./chain.js');
  return createChain({ contractId: desk.contractId, deskKey });
}
