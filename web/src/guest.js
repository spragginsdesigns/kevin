// Guest identity storage. One guest account and key per network, shared by every desk contract on
// that network; registration (storage_deposit + claim_starter) is tracked per contract id.
const key = (network) => `kevin.guest.v1.${network}`;

export function loadGuest(network) {
  try {
    const raw = localStorage.getItem(key(network));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveGuest(network, guest) {
  localStorage.setItem(key(network), JSON.stringify(guest));
}

export function clearGuest(network) {
  localStorage.removeItem(key(network));
}

export function markRegistered(network, contractId) {
  const g = loadGuest(network);
  if (!g) return;
  saveGuest(network, { ...g, registeredOn: { ...(g.registeredOn || {}), [contractId]: Date.now() } });
}

export const isRegisteredHint = (guest, contractId) => Boolean(guest?.registeredOn?.[contractId]);

export function randomGuestId(suffix) {
  const bytes = crypto.getRandomValues(new Uint8Array(5));
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `guest-${hex}${suffix}`;
}
