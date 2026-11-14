import { useEffect, useState } from 'react';

// One shared second tick for every countdown. Uses the chain's clock so the mock's fast-forward
// and the drill desk's short windows render the same way as real time.
export function useNow(chain) {
  const read = () => (chain ? chain.now() : Date.now());
  const [now, setNow] = useState(read);
  useEffect(() => {
    setNow(read());
    const t = setInterval(() => setNow(read()), 1000);
    const jump = () => setNow(read());
    window.addEventListener('kevin:clock', jump);
    return () => {
      clearInterval(t);
      window.removeEventListener('kevin:clock', jump);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chain]);
  return now;
}
