import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const SNAPSHOT = resolve(repo, 'data/kev-snapshot.json');
const RECENT_DAYS = 90;
const DAY = 86_400_000;

// The KEV snapshot is 1.1 MB. The main bundle only carries the entries the queue can show
// (added in the last 90 days of the snapshot). Everything else is a separate chunk that loads
// only when a ticket points at an older CVE.
function kevSnapshot() {
  const ids = { recent: 'virtual:kev-recent', all: 'virtual:kev-all' };
  const load = () => JSON.parse(readFileSync(SNAPSHOT, 'utf8'));
  const slim = (v) => ({
    cveID: v.cveID,
    vendorProject: v.vendorProject,
    product: v.product,
    vulnerabilityName: v.vulnerabilityName,
    dateAdded: v.dateAdded,
    dueDate: v.dueDate,
    knownRansomwareCampaignUse: v.knownRansomwareCampaignUse,
    shortDescription: v.shortDescription,
    requiredAction: v.requiredAction,
  });
  return {
    name: 'kev-snapshot',
    resolveId(id) {
      if (id === ids.recent || id === ids.all) return '\0' + id;
      return null;
    },
    load(id) {
      if (id !== '\0' + ids.recent && id !== '\0' + ids.all) return null;
      this.addWatchFile(SNAPSHOT);
      const snap = load();
      const meta = {
        catalogVersion: snap.catalogVersion,
        dateReleased: snap.dateReleased,
        count: snap.count,
        sourceSha256: snap.sourceSha256,
        source: snap.source,
        mirror: snap.mirror,
      };
      if (id === '\0' + ids.all) {
        return `export default ${JSON.stringify(snap.vulnerabilities.map(slim))};`;
      }
      const cutoff = new Date(Date.parse(snap.dateReleased) - RECENT_DAYS * DAY).toISOString().slice(0, 10);
      const recent = snap.vulnerabilities.filter((v) => v.dateAdded >= cutoff).map(slim);
      return `export const meta = ${JSON.stringify({ ...meta, recentFrom: cutoff, recentCount: recent.length })};\nexport default ${JSON.stringify(recent)};`;
    },
  };
}

export default defineConfig({
  root: here,
  base: './',
  plugins: [react(), kevSnapshot()],
  define: {
    __HAS_MASCOT__: JSON.stringify(existsSync(resolve(here, 'public/kevin.png'))),
  },
  server: { port: 4150, strictPort: true, fs: { allow: [repo] } },
  preview: { port: 4151, strictPort: true },
  build: {
    outDir: resolve(repo, 'dist'),
    emptyOutDir: true,
    chunkSizeWarningLimit: 1600,
  },
});
