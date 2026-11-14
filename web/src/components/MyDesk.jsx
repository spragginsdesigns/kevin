import { forwardRef, useState } from 'react';
import { EXPLORER_ACCOUNT, TOKEN_SYMBOL } from '../config.js';
import { big, fmtInt, fmtToken, parseToken } from '../format.js';
import { explainError } from '../errors.js';
import { titleFor } from '../titles.js';
import { monthName } from '../roster.js';
import { ACTION_LINES, DESK_LINES, clockOutBlock, deskLine, minShiftText, shiftEndsText } from '../kevinSays.js';
import { buildVexDocument, downloadJson, vexBuilderAvailable } from '../data/vex.js';
import { kevLookup } from '../kev.js';
import { TxLink } from './TxLink.jsx';

const STEPS = [
  ['key', 'Make a key in this browser'],
  ['faucet', 'Create the account with the testnet faucet'],
  ['confirm', 'Wait for the account to appear on chain'],
  ['register', 'Register on this desk and take the starter bag'],
];
const ORDER = { key: 0, faucet: 1, confirm: 2, bounds: 3, register: 3, done: 4 };

export const MyDesk = forwardRef(function MyDesk(
  { chain, guest, desk, config, registeredHint, onboard, onOpen, actions, tickets, statements, deskLabel, lastTx, say, unavailable, now },
  ref,
) {
  const registered = Boolean(desk?.registered);
  const starter = config ? fmtToken(config.starter_bag) : null;
  return (
    <aside className="desk" id="desk" ref={ref} aria-labelledby="desk-h">
      <div className="desk-card">
        <div className="desk-clip" aria-hidden="true" />
        <div className="desk-head">
          <h2 id="desk-h">My desk</h2>
          <span className="desk-where">{deskLabel}</span>
        </div>
        {registered ? (
          <Registered
            chain={chain}
            guest={guest}
            desk={desk}
            config={config}
            actions={actions}
            tickets={tickets}
            statements={statements}
            now={now}
            say={say}
          />
        ) : (
          <Onboard
            guest={guest}
            onboard={onboard}
            ready={Boolean(chain)}
            onOpen={onOpen}
            starter={starter}
            deskLabel={deskLabel}
            registeredHint={registeredHint}
            unavailable={unavailable}
            actions={actions}
          />
        )}
        {lastTx && (
          <p className="last-tx">
            <span className="last-tx-label">Last transaction</span>
            <span className="last-tx-what">{lastTx.what}</span>
            <TxLink tx={lastTx} label="Open on the explorer" />
          </p>
        )}
      </div>
    </aside>
  );
});

function Onboard({ ready, guest, onboard, onOpen, starter, deskLabel, registeredHint, unavailable, actions }) {
  const running = onboard.phase === 'running';
  const at = ORDER[onboard.step] ?? -1;
  const hasAccount = guest?.created;
  return (
    <div className="onboard">
      <KevinLine text={DESK_LINES.noDesk} />
      {hasAccount ? (
        <p>
          <strong className="mono">{guest.accountId}</strong> is your guest account on this network. It has no desk on the{' '}
          {deskLabel.toLowerCase()} yet{registeredHint ? ' that this page can see; the chain may be catching up' : ''}. One
          transaction registers it and takes the {starter ? `${starter} ${TOKEN_SYMBOL}` : ''} starter bag.
        </p>
      ) : (
        <p>
          A guest desk is a fresh NEAR testnet account made in this browser. Kevin hands it a starter bag
          {starter ? ` of ${starter} ${TOKEN_SYMBOL}` : ''}. Holding it asks nothing; take the pager when you want to answer
          tickets. The key stays in this browser's storage. Nothing to install, no wallet.
        </p>
      )}
      <button type="button" className="btn btn-ink btn-big" data-primary onClick={onOpen} disabled={running || unavailable || !ready}>
        {running ? 'Opening your desk...' : onboard.phase === 'error' ? 'Try again' : hasAccount ? `Register on the ${deskLabel.toLowerCase()}` : 'Open a guest desk'}
      </button>
      {unavailable && <p className="fine">The desk contract is unreachable right now, so a desk cannot be opened.</p>}
      {(running || onboard.phase === 'error' || onboard.phase === 'done') && (
        <ol className="steps" aria-label="Progress">
          {STEPS.filter(([k]) => !(hasAccount && (k === 'faucet' || k === 'confirm') && at < 1)).map(([k, label]) => {
            const i = ORDER[k];
            const state =
              onboard.phase === 'error' && i === Math.max(at, 0) ? 'err' : i < at || onboard.phase === 'done' ? 'done' : i === at ? 'now' : 'wait';
            return (
              <li key={k} className={`step step-${state}`}>
                <span className="step-mark" aria-hidden="true" />
                <span>{label}</span>
                <span className="sr-only">{{ done: 'done', now: 'in progress', err: 'failed', wait: 'waiting' }[state]}</span>
              </li>
            );
          })}
        </ol>
      )}
      {onboard.phase === 'error' && (
        <div className="notice notice-error notice-tight" role="alert">
          <p>{onboard.error}</p>
          <p className="fine">{onboard.code === 'rate_limit' ? 'Your key is saved; trying again reuses the same account name.' : 'Nothing was charged. You can try again.'}</p>
        </div>
      )}
      {hasAccount && !running && (
        <ForgetGuest onForget={actions.forget} />
      )}
    </div>
  );
}

function KevinLine({ text }) {
  return (
    <p className="kevin-line">
      <span className="kevin-line-who">Kevin</span>
      <span className="kevin-line-text">{text}</span>
    </p>
  );
}

function Registered({ chain, guest, desk, config, actions, tickets, statements, now, say }) {
  const title = titleFor(desk);
  const pending = big(desk.pending_burn);
  const onRoster = Number(desk.first_on_call_ms) > 0;
  return (
    <div className="registered">
      <div className="badge">
        <div className="badge-rank">
          <span className="badge-label">Title</span>
          <span className="badge-rank-name">{title}</span>
        </div>
        <a className="badge-account mono" href={chain?.mock ? undefined : `${EXPLORER_ACCOUNT}${guest.accountId}`} target="_blank" rel="noreferrer">
          {guest.accountId}
        </a>
      </div>

      <KevinLine text={deskLine({ desk, tickets, statements, now })} />

      <div className="balance">
        <div className="balance-row">
          <span className="balance-label">Free balance</span>
          <span className="balance-value">
            {fmtToken(desk.balance, { decimals: 2 })} <span className="balance-unit">{TOKEN_SYMBOL}</span>
          </span>
          <span className="balance-stored">Never burns. Yours to send.</span>
        </div>
        {desk.on_call && (
          <div className="balance-row balance-committed">
            <span className="balance-label">Committed</span>
            <span className="balance-value">
              {fmtToken(desk.committed, { decimals: 2 })} <span className="balance-unit">{TOKEN_SYMBOL}</span>
            </span>
            <span className={`balance-stored ${pending > 0n ? 'is-bad' : ''}`}>
              {pending > 0n
                ? `Stored ${fmtToken(desk.stored_committed, { decimals: 2 })}, minus a pending burn of ${fmtToken(desk.pending_burn, { decimals: 2 })}`
                : 'Locked while you are on call. Each miss burns part of it.'}
            </span>
          </div>
        )}
      </div>

      {desk.on_call ? (
        <OnCallPanel desk={desk} config={config} actions={actions} tickets={tickets} statements={statements} now={now} say={say} />
      ) : (
        <TakePager key={guest.accountId} desk={desk} config={config} onGo={actions.goOnCall} say={say} />
      )}

      {desk.on_call && pending > 0n && <Settle desk={desk} onSettle={actions.settle} say={say} />}

      {onRoster && <Record desk={desk} />}

      <Send onSend={actions.transfer} balance={desk.balance} say={say} />
      {desk.on_call && <Oncall onAdd={actions.addOncallKey} say={say} mock={chain?.mock} />}
      <ExportVex chain={chain} guest={guest} tickets={tickets} statements={statements} say={say} />
      <ForgetGuest onForget={actions.forget} />
    </div>
  );
}

function Record({ desk }) {
  return (
    <>
      <dl className="record" aria-label="Lifetime record">
        <div>
          <dt>On time</dt>
          <dd>{fmtInt(desk.on_time)}</dd>
        </div>
        <div>
          <dt>Missed</dt>
          <dd className={desk.missed ? 'bad' : ''}>{fmtInt(desk.missed)}</dd>
        </div>
        <div>
          <dt>Streak</dt>
          <dd>{fmtInt(desk.streak)}</dd>
        </div>
        <div>
          <dt>Best</dt>
          <dd>{fmtInt(desk.best_streak)}</dd>
        </div>
      </dl>
      <div className="month">
        <p className="month-h">This month, {monthName(desk.month)}</p>
        <dl className="month-nums">
          <div>
            <dt>Answered on time</dt>
            <dd>{fmtInt(desk.month_on_time)}</dd>
          </div>
          <div>
            <dt>Ignored</dt>
            <dd className={desk.month_missed ? 'bad' : ''}>{fmtInt(desk.month_missed)}</dd>
          </div>
          <div>
            <dt>Burned</dt>
            <dd className={big(desk.month_burned) > 0n ? 'bad' : ''}>
              {fmtToken(desk.month_burned, { decimals: 2 })} <span className="balance-unit">{TOKEN_SYMBOL}</span>
            </dd>
          </div>
        </dl>
      </div>
      {big(desk.burned) > 0n && (
        <p className="fine">
          Lost to silence so far: {fmtToken(desk.burned, { decimals: 2 })} {TOKEN_SYMBOL}, all of it from committed tokens.
        </p>
      )}
    </>
  );
}

// Holder, not on call: the free balance and the form that commits part of it.
function TakePager({ desk, config, onGo, say }) {
  const free = big(desk.balance);
  const min = big(config?.min_commit);
  const unit = 10n ** 18n;
  const [amount, setAmount] = useState(() => String(free / 2n / unit));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const short = min > 0n && free < min;
  const submit = async (e) => {
    e.preventDefault();
    setErr(null);
    const raw = parseToken(amount);
    if (raw === null || raw <= 0n) return setErr('Enter an amount greater than zero.');
    if (raw < min) return setErr(`The minimum to take the pager is ${fmtToken(min)} ${TOKEN_SYMBOL}.`);
    if (raw > free) return setErr(`You have ${fmtToken(free, { decimals: 2 })} ${TOKEN_SYMBOL} free.`);
    setBusy(true);
    try {
      const r = await onGo(raw);
      say(ACTION_LINES.onCall, 'good', r);
    } catch (x) {
      setErr(explainError(x));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="pager" onSubmit={submit} noValidate aria-labelledby="pager-h">
      <h3 className="pager-h" id="pager-h">
        The On-Call Program
      </h3>
      <p className="fine">
        Commit part of your bag and answer every ticket by CISA's deadline. Each ticket that expires unanswered while you are
        on call burns {pctOf(config?.miss_bps)} of what you committed ({pctOf(config?.ransom_miss_bps)} for ransomware bugs).
        Committed tokens cannot be sent. Your free balance never burns.
      </p>
      <label>
        <span>Amount to commit</span>
        <input
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          inputMode="decimal"
          autoComplete="off"
          aria-describedby="pager-min"
          disabled={short}
        />
      </label>
      <p className="fine" id="pager-min">
        {min > 0n ? `Minimum ${fmtToken(min)} ${TOKEN_SYMBOL}. ` : ''}
        {config?.min_shift_ms ? minShiftText(config.min_shift_ms) : ''}
        {config?.min_shift_ms ? ' You can clock out after that once every open ticket is answered.' : ''}
      </p>
      {short && <p className="form-err">You need at least {fmtToken(min)} {TOKEN_SYMBOL} free to take the pager.</p>}
      {err && (
        <p className="form-err" role="alert">
          {err}
        </p>
      )}
      <button type="submit" className="btn btn-ink btn-big" data-primary disabled={busy || short}>
        {busy ? 'Taking the pager...' : 'Take the pager'}
      </button>
    </form>
  );
}

const pctOf = (bps) => (bps == null ? '' : `${Number(bps) / 100}%`);

// On call: the shift, a top-up and the way out.
function OnCallPanel({ desk, config, actions, tickets, statements, now, say }) {
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState(null);
  const ends = Number(desk.shift_ends_ms);
  const clockOut = async () => {
    setRefusal(null);
    // The contract would refuse; say why without sending a transaction that is bound to fail.
    const block = clockOutBlock({ desk, tickets, statements, now });
    if (block) return setRefusal(block);
    setBusy(true);
    try {
      const r = await actions.clockOut();
      say(ACTION_LINES.clockedOut, 'good', r);
    } catch (x) {
      const msg = String(x?.message || x);
      if (msg.includes('your shift is not over')) setRefusal({ reason: 'shift', line: DESK_LINES.shiftRefused(ends) });
      else if (msg.includes('answer every open ticket before you clock out')) setRefusal({ reason: 'queue', line: DESK_LINES.clockOutRefused, tickets: [] });
      else setRefusal({ reason: 'error', line: explainError(x) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="shift">
      <p className="shift-ends">
        <span className="stamp-dot is-on" aria-hidden="true" /> {ends ? shiftEndsText(ends) : 'On call'}
      </p>
      <TopUp desk={desk} onAdd={actions.goOnCall} say={say} />
      <button type="button" className="btn btn-ghost btn-wide" data-action="clock-out" disabled={busy} onClick={clockOut}>
        {busy ? 'Clocking out...' : 'Clock out'}
      </button>
      {refusal && (
        <div className="refusal" role="alert">
          <p className="kevin-line-text">{refusal.line}</p>
          {refusal.reason === 'queue' && refusal.tickets?.length > 0 && (
            <p className="fine">Still unanswered: {refusal.tickets.map((t) => t.cve_id).join(', ')}.</p>
          )}
          {refusal.reason === 'shift' && <p className="fine">{config?.min_shift_ms ? minShiftText(config.min_shift_ms) : ''} It started when you took the pager.</p>}
        </div>
      )}
      <p className="fine">Clocking out returns everything still committed to your free balance. Your record stays.</p>
    </div>
  );
}

function TopUp({ desk, onAdd, say }) {
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const submit = async (e) => {
    e.preventDefault();
    setErr(null);
    const raw = parseToken(amount);
    if (raw === null || raw <= 0n) return setErr('Enter an amount greater than zero.');
    if (raw > big(desk.balance)) return setErr(`You have ${fmtToken(desk.balance, { decimals: 2 })} ${TOKEN_SYMBOL} free.`);
    setBusy(true);
    try {
      const r = await onAdd(raw);
      say(`Added ${fmtToken(raw, { decimals: 2 })} ${TOKEN_SYMBOL} to your commitment.`, 'good', r);
      setAmount('');
    } catch (x) {
      setErr(explainError(x));
    } finally {
      setBusy(false);
    }
  };
  return (
    <details className="tool">
      <summary>Add to commitment</summary>
      <form className="send" onSubmit={submit} noValidate>
        <label>
          <span>Amount</span>
          <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="1000" inputMode="decimal" autoComplete="off" />
        </label>
        {err && (
          <p className="form-err" role="alert">
            {err}
          </p>
        )}
        <p className="fine">Misses already due burn first, at the amount you committed before.</p>
        <button type="submit" className="btn btn-ink" disabled={busy}>
          {busy ? 'Adding...' : 'Add to commitment'}
        </button>
      </form>
    </details>
  );
}

function Settle({ desk, onSettle, say }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  return (
    <div className="settle">
      <p className="settle-title">
        <span className="stamp-dot" aria-hidden="true" /> {fmtInt(desk.unsettled)} expired {desk.unsettled === 1 ? 'ticket' : 'tickets'} not yet settled
      </p>
      <p className="fine">
        Settling applies the burn for every ticket you left silent while on call, from your committed tokens. Anyone can run
        it for any desk, and every answer, top-up and clock out runs it first, so the burn cannot be dodged.
      </p>
      <button
        type="button"
        className="btn btn-red"
        disabled={busy}
        data-action="settle"
        onClick={async () => {
          setBusy(true);
          try {
            const r = await onSettle();
            const v = r.value || { settled: 0, remaining: 0, burned: '0' };
            setResult(v);
            say(`Settled ${v.settled} ${v.settled === 1 ? 'ticket' : 'tickets'}. Burned ${fmtToken(v.burned, { decimals: 2 })} ${TOKEN_SYMBOL}.`, 'bad', r);
          } catch (e) {
            say(explainError(e), 'bad');
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? 'Settling...' : `Settle: burn ${fmtToken(desk.pending_burn, { decimals: 2 })} ${TOKEN_SYMBOL}`}
      </button>
      {result && result.remaining > 0 && <p className="fine">{result.remaining} more to settle. Run it again.</p>}
    </div>
  );
}

function Send({ onSend, balance, say }) {
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const submit = async (e) => {
    e.preventDefault();
    setErr(null);
    const raw = parseToken(amount);
    const receiver = to.trim().toLowerCase();
    if (!/^[a-z0-9._-]{2,64}$/.test(receiver)) return setErr('Enter a NEAR account id, like friend.testnet.');
    if (raw === null || raw <= 0n) return setErr('Enter an amount greater than zero.');
    if (raw > big(balance)) return setErr(`You have ${fmtToken(balance, { decimals: 2 })} ${TOKEN_SYMBOL} free.`);
    setBusy(true);
    try {
      const r = await onSend(receiver, raw);
      say(`Sent ${fmtToken(raw, { decimals: 2 })} ${TOKEN_SYMBOL} to ${receiver}.`, 'good', r);
      setAmount('');
    } catch (x) {
      setErr(explainError(x));
    } finally {
      setBusy(false);
    }
  };
  return (
    <details className="tool">
      <summary>Send {TOKEN_SYMBOL}</summary>
      <form className="send" onSubmit={submit} noValidate>
        <label>
          <span>To account</span>
          <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="friend.testnet" autoComplete="off" autoCapitalize="none" spellCheck="false" required />
        </label>
        <label>
          <span>Amount</span>
          <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="100" inputMode="decimal" autoComplete="off" required />
        </label>
        {err && (
          <p className="form-err" role="alert">
            {err}
          </p>
        )}
        <p className="fine">The receiver needs a desk on this contract. A transfer moves only your free balance; committed tokens stay put.</p>
        <button type="submit" className="btn btn-ink" disabled={busy}>
          {busy ? 'Sending...' : 'Send'}
        </button>
      </form>
    </details>
  );
}

function Oncall({ onAdd, say, mock }) {
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState(null);
  const [err, setErr] = useState(null);
  const file = key
    ? JSON.stringify({ account_id: key.accountId, contract_id: key.contractId, public_key: key.publicKey, private_key: key.secretKey }, null, 2)
    : '';
  return (
    <details className="tool">
      <summary>On-call key</summary>
      <div className="oncall">
        <p>
          Adds a NEAR access key to your account that can call <code>close_ticket</code> on this contract and nothing else.
          A bot can keep you answered but cannot move your tokens.
        </p>
        {!key && (
          <button
            type="button"
            className="btn btn-ink"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setErr(null);
              try {
                const k = await onAdd();
                setKey(k);
                say('On-call key added. Copy it now; it is shown once.', 'good', k);
              } catch (e) {
                setErr(explainError(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? 'Adding key...' : 'Add on-call key'}
          </button>
        )}
        {err && <p className="form-err" role="alert">{err}</p>}
        {key && (
          <div className="keybox">
            <p className="fine">
              Shown once. Save it as <code>.kevin/oncall.json</code> in the repo, list what you run in an inventory file, then run the bot.
              {mock ? ' (Demo chain: this key is not on testnet.)' : ''}
            </p>
            <pre tabIndex={0} aria-label="On-call key file">{file}</pre>
            <div className="keybox-actions">
              <button
                type="button"
                className="btn btn-small"
                onClick={() =>
                  navigator.clipboard?.writeText(file).then(
                    () => say('Copied the key file.', 'good'),
                    () => say('Copy failed. Select the text and copy it by hand.', 'warn'),
                  )
                }
              >
                Copy
              </button>
              <button type="button" className="btn btn-small btn-ghost" onClick={() => setKey(null)}>
                I saved it, hide
              </button>
            </div>
            <pre className="cmd">npm run oncall -- --inventory scripts/inventory.example.json --dry-run</pre>
          </div>
        )}
      </div>
    </details>
  );
}

function ExportVex({ chain, guest, tickets, statements, say }) {
  const ids = Object.keys(statements);
  return (
    <div className="tool tool-flat">
      <button
        type="button"
        className="btn btn-ghost btn-wide"
        data-action="vex"
        disabled={!ids.length}
        onClick={async () => {
          const byId = new Map(tickets.map((t) => [String(t.id), t]));
          const list = await Promise.all(
            ids
              .filter((id) => byId.has(id))
              .map(async (id) => {
                const ticket = byId.get(id);
                const kev = await kevLookup(ticket.cve_id).catch(() => null);
                return { ticket, statement: statements[id], requiredAction: kev?.entry?.requiredAction };
              }),
          );
          const timestamp = new Date().toISOString();
          const { kind, doc } = await buildVexDocument({
            accountId: guest.accountId,
            network: chain.network,
            contractId: chain.contractId,
            statements: list,
            author: guest.accountId,
            timestamp,
          });
          downloadJson(`kevin-${kind}-${guest.accountId.replace(/\.testnet$/, '')}-${chain.deskKey}.json`, doc);
          say(`Exported ${list.length} ${list.length === 1 ? 'statement' : 'statements'}${kind === 'openvex' ? ' as OpenVEX' : ''}.`, 'good');
        }}
      >
        Export OpenVEX ({ids.length})
      </button>
      {!vexBuilderAvailable && <p className="fine">OpenVEX builder not in this build; exports the raw statements.</p>}
    </div>
  );
}

function ForgetGuest({ onForget }) {
  const [sure, setSure] = useState(false);
  return (
    <div className="forget">
      {sure ? (
        <>
          <p className="fine">
            This only removes the key from this browser. The account and its desk stay on testnet (desks are permanent; if it
            is on call, its record and any burns keep counting), but this browser can no longer sign for it.
          </p>
          <div className="keybox-actions">
            <button type="button" className="btn btn-small btn-red" onClick={onForget}>
              Remove the key
            </button>
            <button type="button" className="btn btn-small btn-ghost" onClick={() => setSure(false)}>
              Keep it
            </button>
          </div>
        </>
      ) : (
        <button type="button" className="linkish" onClick={() => setSure(true)}>
          Forget this guest
        </button>
      )}
    </div>
  );
}
