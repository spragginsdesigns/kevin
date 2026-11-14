// A rubber stamp. `fresh` (a timestamp from this session) plays the thunk once; stamps that were
// already on the record render still, so a reload does not replay every stamp.
export function Stamp({ kind, label, fresh, small = false }) {
  const recent = typeof fresh === 'number' ? Date.now() - fresh < 4000 : Boolean(fresh);
  return (
    <span className={`stamp stamp-${kind} ${small ? 'stamp-small' : ''} ${recent ? 'stamp-thunk' : ''}`} aria-hidden={small ? 'true' : undefined}>
      <span className="stamp-inner">{label}</span>
    </span>
  );
}
