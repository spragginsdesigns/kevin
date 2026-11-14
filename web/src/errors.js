// Turn contract panics and RPC failures into one plain sentence for the person at the desk.
import { DESK_LINES } from './kevinSays.js';

// Checked in order, so a longer panic text comes before any shorter one it contains.
const PANICS = [
  ['answer every open ticket before you clock out', DESK_LINES.clockOutRefused],
  ['your shift is not over', 'Your shift is not over yet. A desk on call stays on call for the whole minimum shift.'],
  ['go on call first: go_on_call', 'Only desks on call can answer. Take the pager first.'],
  ['commit at least the minimum to go on call', 'That is less than the minimum it takes to go on call.'],
  ['not enough free balance: committed tokens cannot move', 'Committed tokens cannot move. You can only send your free balance.'],
  ['not enough free balance', 'You do not have that much free KEVIN.'],
  ['amount must be positive', 'Enter an amount greater than zero.'],
  ['not on call', 'This desk is not on call.'],
  ['deadline passed', 'The deadline passed before your answer landed. Silence is already on the record.'],
  ['account behind: call settle first', 'Your desk has unsettled misses. Run Settle first, then try again.'],
  ['register first: storage_deposit', 'This account has no desk on this contract yet.'],
  ['starter already claimed', 'This account already took its starter bag on this desk.'],
  ['desk pool is empty', 'The desk pool is empty, so there is no starter bag left to hand out.'],
  ['no such ticket', 'That ticket does not exist on this desk.'],
  ['The account doesn\'t have enough balance', 'Not enough KEVIN for that transfer.'],
  ['Not enough balance', 'Not enough KEVIN for that transfer.'],
  ['is not registered', 'The receiver has no desk on this contract. They need to open one first.'],
  ['The account doesn\'t have any storage', 'The receiver has no desk on this contract. They need to open one first.'],
];

export function explainError(e) {
  if (!e) return 'Something went wrong.';
  if (e.code && e.message) return e.message;
  const msg = String(e.message || e);
  for (const [needle, text] of PANICS) if (msg.includes(needle)) return text;
  if (/does not exist/i.test(msg) && /Account/i.test(msg)) return 'The desk contract was not found on testnet.';
  if (/method is not found|MethodNotFound/i.test(msg)) return 'The contract at this address is not the KEVIN desk (method not found).';
  if (/rate|429/i.test(msg)) return 'The RPC node is rate limiting requests. Wait a few seconds and try again.';
  if (/fetch|network|Failed to|timeout|ECONN/i.test(msg)) return 'Could not reach a NEAR RPC node. Check your connection and try again.';
  // Anything else the contract refused with: its own words, without the runtime's prefix.
  const panic = msg.match(/Smart contract panicked: ([^\n"}]+)/);
  if (panic) return `The contract refused: ${panic[1].trim()}.`;
  return msg.length > 160 ? `${msg.slice(0, 157)}...` : msg;
}

export const isTransportError = (e) =>
  e instanceof TypeError ||
  /fetch|network|timeout|timed out|ECONN|socket|aborted|429|rate|50[0-9]|Retries|Exceeded|JSON RPC response|Bad Gateway|unavailable|Internal server error|outage/i.test(String(e?.message || e));

export const isMissingContract = (e) => /does not exist/i.test(String(e?.message || e)) || e?.code === 'missing_contract';
