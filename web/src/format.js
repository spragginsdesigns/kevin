import { TOKEN_DECIMALS } from './config.js';

const UNIT = 10n ** BigInt(TOKEN_DECIMALS);

export const big = (x) => {
  try {
    return BigInt(x ?? 0);
  } catch {
    return 0n;
  }
};

const group = (s) => s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

// Format a raw token amount (18 decimals) for display. Whole tokens get thousands separators;
// fractions are shown only when the amount is small enough for them to matter.
export function fmtToken(raw, { decimals } = {}) {
  const v = big(raw);
  const neg = v < 0n;
  const a = neg ? -v : v;
  const whole = a / UNIT;
  const frac = a % UNIT;
  const d = decimals ?? (whole >= 1000n ? 0 : whole >= 1n ? 2 : 4);
  let out = group(whole.toString());
  if (d > 0) {
    const f = frac.toString().padStart(TOKEN_DECIMALS, '0').slice(0, d).replace(/0+$/, '');
    if (f) out += '.' + f;
  } else if (frac > 0n && whole === 0n) {
    out = '<1';
  }
  return (neg ? '-' : '') + out;
}

// Parse a user-typed decimal amount into raw units. Returns null when it is not a valid amount.
export function parseToken(text) {
  const t = String(text || '').trim().replace(/,/g, '');
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const [w, f = ''] = t.split('.');
  if (f.length > TOKEN_DECIMALS) return null;
  return BigInt(w) * UNIT + BigInt(f.padEnd(TOKEN_DECIMALS, '0') || '0');
}

// Percent of `part` in `whole` with enough precision to show tiny burns.
export function fmtPct(part, whole) {
  const p = big(part);
  const w = big(whole);
  if (w === 0n) return '0%';
  const bp = Number((p * 10_000_000n) / w) / 100_000; // percent with 5 decimals
  if (bp === 0) return '0%';
  if (bp < 0.001) return '<0.001%';
  if (bp < 1) return `${bp.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}%`;
  return `${bp.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}%`;
}

export const fmtInt = (n) => group(String(Number(n) || 0));

const pad = (n) => String(n).padStart(2, '0');

// Countdown parts for a deadline. Days only appear when there is at least one.
export function countdown(deadlineMs, nowMs) {
  const left = Number(deadlineMs) - nowMs;
  if (left <= 0) return { over: true, text: '00:00:00', left: 0, urgent: true };
  const s = Math.floor(left / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  let text;
  if (d > 0) text = `${d}d ${pad(h)}:${pad(m)}:${pad(sec)}`;
  else if (h > 0) text = `${pad(h)}:${pad(m)}:${pad(sec)}`;
  else text = `${pad(m)}:${pad(sec)}`;
  return { over: false, text, left, urgent: left < 3_600_000, d, h, m, s: sec };
}

// Spoken form for screen readers (they should not hear the ticking digits).
export function countdownWords(deadlineMs, nowMs) {
  const c = countdown(deadlineMs, nowMs);
  if (c.over) return 'deadline passed';
  if (c.d > 0) return `${c.d} days ${c.h} hours left`;
  if (c.h > 0) return `${c.h} hours ${c.m} minutes left`;
  return `${c.m} minutes ${c.s} seconds left`;
}

export const utcStamp = (ms) => {
  const d = new Date(Number(ms));
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 19)} UTC`;
};

export const shortAccount = (a) => {
  if (!a) return '';
  return a.length > 26 ? `${a.slice(0, 14)}...${a.slice(-9)}` : a;
};

export const ticketNo = (id) => String(id).padStart(4, '0');

export const STATUS_LABEL = { not_affected: 'Not affected', fixed: 'Fixed', mitigated: 'Mitigated' };
export const STATUSES = ['not_affected', 'fixed', 'mitigated'];
