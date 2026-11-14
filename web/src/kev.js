// CISA KEV details for ticket expansion. Recent entries ship in the bundle; older ones load from a
// lazy chunk of the committed snapshot; entries newer than the snapshot come from the live mirror.
import recent, { meta } from 'virtual:kev-recent';
import { KEV_MIRROR } from './config.js';

export const kevMeta = meta;
const byCve = new Map(recent.map((v) => [v.cveID, v]));
let allPromise = null;
let mirrorPromise = null;

export const recentEntries = recent;
export const kevLocal = (cve) => byCve.get(cve) || null;

function loadAll() {
  allPromise ||= import('virtual:kev-all').then((m) => {
    for (const v of m.default) if (!byCve.has(v.cveID)) byCve.set(v.cveID, v);
    return true;
  });
  return allPromise;
}

function loadMirror() {
  mirrorPromise ||= fetch(KEV_MIRROR, { cache: 'no-cache' })
    .then((r) => {
      if (!r.ok) throw new Error(`mirror HTTP ${r.status}`);
      return r.json();
    })
    .then((j) => {
      for (const v of j.vulnerabilities || []) if (!byCve.has(v.cveID)) byCve.set(v.cveID, v);
      return true;
    })
    .catch((e) => {
      mirrorPromise = null;
      throw e;
    });
  return mirrorPromise;
}

// Resolve the CISA entry for a CVE: bundle, then full snapshot, then the live mirror.
export async function kevLookup(cve) {
  if (byCve.has(cve)) return { entry: byCve.get(cve), source: 'snapshot' };
  await loadAll();
  if (byCve.has(cve)) return { entry: byCve.get(cve), source: 'snapshot' };
  await loadMirror();
  if (byCve.has(cve)) return { entry: byCve.get(cve), source: 'mirror' };
  return { entry: null, source: 'none' };
}

export async function kevAll() {
  await loadAll();
  return byCve;
}
