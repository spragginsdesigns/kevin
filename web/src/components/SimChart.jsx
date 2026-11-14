import { useEffect, useRef, useState } from 'react';
import { simReport, simIsPlaceholder } from '../data/simReport.js';
import { fmtInt } from '../format.js';

const COLORS = {
  on_call: '#1d6b3c',
  nine_to_five: '#215a7d',
  weekly: '#1b1a17',
  patch_tuesday: '#6b4a2b',
  quarterly: '#a14a0b',
  ghost: '#b0261c',
};
const FALLBACK = ['#1d6b3c', '#215a7d', '#1b1a17', '#6b4a2b', '#a14a0b', '#b0261c'];
const colorFor = (h, i) => COLORS[h.id] || FALLBACK[i % FALLBACK.length];
const pctBps = (bps) => (bps <= 0 ? '<0.01%' : `${(bps / 100).toFixed(bps >= 1000 ? 0 : bps >= 10 ? 1 : 2)}%`);

function useWidth(ref) {
  const [w, setW] = useState(720);
  useEffect(() => {
    if (!ref.current) return undefined;
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.round(e.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

export function SimChart() {
  const r = simReport;
  const box = useRef(null);
  const width = useWidth(box);
  const narrow = width < 560;
  const height = narrow ? 240 : 340;
  const pad = { l: narrow ? 40 : 52, r: narrow ? 12 : 168, t: 16, b: 30 };
  const t0 = Date.parse(r.from);
  const t1 = Date.parse(r.to);
  const x = (d) => pad.l + ((Date.parse(d) - t0) / (t1 - t0)) * (width - pad.l - pad.r);
  const y = (bps) => pad.t + (1 - bps / 10000) * (height - pad.t - pad.b);
  const years = [];
  for (let yr = new Date(t0).getUTCFullYear() + 1; yr <= new Date(t1).getUTCFullYear(); yr++) years.push(yr);

  // End labels, pushed apart so they never overlap.
  const labels = r.holders
    .map((h, i) => ({ h, i, y: y(h.keptBps) }))
    .sort((a, b) => a.y - b.y);
  for (let k = 1; k < labels.length; k++) labels[k].y = Math.max(labels[k].y, labels[k - 1].y + 15);
  const floor = height - pad.b + 8;
  for (let k = labels.length - 1; k >= 0; k--) {
    const cap = k === labels.length - 1 ? floor : labels[k + 1].y - 15;
    labels[k].y = Math.min(labels[k].y, cap);
  }
  // Lines that end on top of each other: draw the extremes last so they stay visible.
  const drawOrder = r.holders.map((h, i) => ({ h, i })).sort((a, b) => rankDraw(a.h) - rankDraw(b.h));

  return (
    <section className="sim" aria-labelledby="sim-h">
      <div className="section-head">
        <h2 id="sim-h">Five years of real deadlines</h2>
        <p className="section-sub">
          Every KEV entry from {r.from} to {r.to} ({fmtInt(r.tickets)} tickets) replayed through the burn rule:{' '}
          {r.missBps / 100}% per miss, {r.ransomMissBps / 100}% for ransomware. Share of its committed stake each kind of
          on-call desk keeps.
        </p>
      </div>
      <div className={`sim-paper ${simIsPlaceholder ? 'is-placeholder' : ''}`}>
        {simIsPlaceholder && (
          <p className="sim-flag" role="note">
            Preview: only two desk types. The full table comes from <code>npm run sim</code>.
          </p>
        )}
        <Facts facts={r.facts} />

        <div className="sim-chart" ref={box}>
          <svg width={width} height={height} role="img" aria-label={`Line chart of the share of a committed stake kept, ${r.from} to ${r.to}. ${r.holders.map((h) => `${h.label}: ${pctBps(h.keptBps)}`).join('. ')}.`}>
            {[0, 2500, 5000, 7500, 10000].map((b) => (
              <g key={b}>
                <line x1={pad.l} x2={width - pad.r} y1={y(b)} y2={y(b)} className={b === 0 ? 'axis' : 'grid'} />
                <text x={pad.l - 8} y={y(b) + 4} className="tick" textAnchor="end">
                  {b / 100}%
                </text>
              </g>
            ))}
            {years.map((yr) => {
              const xx = x(`${yr}-01-01`);
              return (
                <g key={yr}>
                  <line x1={xx} x2={xx} y1={height - pad.b} y2={height - pad.b + 5} className="axis" />
                  <text x={xx} y={height - 8} className="tick" textAnchor="middle">
                    {narrow ? `'${String(yr).slice(2)}` : yr}
                  </text>
                </g>
              );
            })}
            {drawOrder.map(({ h, i }) => (
              <path
                key={h.id}
                d={h.series.map((p, k) => `${k ? 'L' : 'M'}${x(p.date).toFixed(1)},${y(p.keptBps).toFixed(1)}`).join('')}
                fill="none"
                stroke={colorFor(h, i)}
                strokeWidth={h.id === 'ghost' || h.id === 'on_call' ? 3 : 2}
                strokeLinejoin="round"
              />
            ))}
            {!narrow &&
              labels.map(({ h, i, y: ly }) => (
                <text key={h.id} x={width - pad.r + 8} y={ly + 4} className="end-label" fill={colorFor(h, i)}>
                  {shortLabel(h)} {pctBps(h.keptBps)}
                </text>
              ))}
          </svg>
        </div>
        <div className="sim-table" role="table" aria-label="Holder results">
          <div className="sim-row sim-head" role="row">
            <span role="columnheader">On-call desk</span>
            <span role="columnheader" className="num">Answered</span>
            <span role="columnheader" className="num">Missed</span>
            <span role="columnheader" className="num">Ransomware missed</span>
            <span role="columnheader" className="num">Stake kept</span>
          </div>
          {r.holders.map((h, i) => (
            <div className="sim-row" role="row" key={h.id}>
              <span role="cell" className="sim-holder">
                <span className="swatch" style={{ background: colorFor(h, i) }} aria-hidden="true" />
                {h.label}
              </span>
              <span role="cell" className="num" data-label="Answered">{fmtInt(h.answered)}</span>
              <span role="cell" className="num" data-label="Missed">{fmtInt(h.missed)}</span>
              <span role="cell" className="num" data-label="Ransomware missed">{fmtInt(h.missedRansomware)}</span>
              <span role="cell" className="num kept" data-label="Stake kept">{pctBps(h.keptBps)}</span>
            </div>
          ))}
        </div>
        <p className="fine sim-source">
          Source: CISA KEV catalog {r.catalogVersion}, sha256 {String(r.sourceSha256).slice(0, 12)}. Uses each entry's real
          dateAdded and dueDate; ransomware flag as of the snapshot.
        </p>
      </div>
    </section>
  );
}

// Catalog facts computed by `npm run sim` (data/sim-report.json `facts`); hidden when absent.
function Facts({ facts }) {
  const w = facts?.windowDays;
  if (!w) return null;
  const short = w.buckets?.find((b) => b.label === '1-3');
  const items = [
    ['Median window', `${w.median} days`],
    short && ['3 days or less', `${fmtInt(short.count)} entries`],
    w.max && ['Longest window', `${w.max} days`],
    facts.ransomwareBps != null && ['Ransomware-flagged', `${(facts.ransomwareBps / 100).toFixed(1)}%`],
    facts.peakOpen && ['Most open at once', `${fmtInt(facts.peakOpen)} (${facts.peakOpenDate})`],
  ].filter(Boolean);
  return (
    <dl className="sim-facts">
      {items.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function rankDraw(h) {
  return h.id === 'on_call' ? 2 : h.id === 'ghost' ? 1 : 0;
}

function shortLabel(h) {
  return h.label.replace(/\s*\(.*\)$/, '');
}
