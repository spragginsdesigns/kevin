import { useEffect, useRef, useState } from 'react';
import { big, fmtToken } from '../format.js';

const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const UNIT = 10n ** 16n; // tween in hundredths of a token

// A token amount that counts to its new value when a burn lands, so the supply visibly drops.
export function AnimatedAmount({ value, rising = false }) {
  const target = big(value);
  const [shown, setShown] = useState(target);
  const [moving, setMoving] = useState(false);
  const prev = useRef(target);
  useEffect(() => {
    const from = prev.current;
    prev.current = target;
    if (from === target) return undefined;
    if (reduced() || from === 0n) {
      setShown(target);
      return undefined;
    }
    const a = Number(from / UNIT);
    const b = Number(target / UNIT);
    const start = performance.now();
    const dur = 1100;
    let raf;
    setMoving(true);
    const step = (t) => {
      const k = Math.min(1, (t - start) / dur);
      const e = 1 - Math.pow(1 - k, 3);
      if (k < 1) {
        setShown(BigInt(Math.round(a + (b - a) * e)) * UNIT);
        raf = requestAnimationFrame(step);
      } else {
        setShown(target);
        setMoving(false);
      }
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  const cls = moving ? (rising ? 'amt amt-rising' : 'amt amt-falling') : 'amt';
  return <span className={cls}>{fmtToken(shown, { decimals: rising && target < 10n ** 21n ? 2 : 0 })}</span>;
}
