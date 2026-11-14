// OpenVEX export. Uses buildOpenVex from lib/vex.mjs (shared with `npm run vex`) when it exists;
// the glob resolves at build time, so the real builder is picked up with no code change.
// Without it, the download is a plain JSON list of the account's on-chain statements.
const mods = import.meta.glob('../../../lib/vex.mjs');
const loader = Object.values(mods)[0];

export const vexBuilderAvailable = Boolean(loader);

export async function buildVexDocument({ accountId, network, contractId, statements, author, timestamp }) {
  if (loader) {
    try {
      const mod = await loader();
      if (typeof mod.buildOpenVex === 'function') {
        return { kind: 'openvex', doc: mod.buildOpenVex({ accountId, network, contractId, statements, author, timestamp }) };
      }
    } catch (e) {
      console.warn('lib/vex.mjs failed to load, exporting raw statements instead', e);
    }
  }
  return {
    kind: 'statements',
    doc: {
      note: 'OpenVEX builder unavailable in this build; these are the raw on-chain statements.',
      account_id: accountId,
      network,
      contract_id: contractId,
      exported_at: timestamp,
      statements: statements.map(({ ticket, statement }) => ({
        ticket_id: ticket.id,
        cve_id: ticket.cve_id,
        vendor: ticket.vendor,
        product: ticket.product,
        deadline_ms: ticket.deadline_ms,
        status: statement.status,
        at_ms: statement.at_ms,
      })),
    },
  };
}

export function downloadJson(filename, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2) + '\n'], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
