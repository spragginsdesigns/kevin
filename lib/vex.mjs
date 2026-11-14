// OpenVEX export of an account's on-chain statements. Browser-safe (no Node imports): the web app's
// "Export OpenVEX" button and scripts/vex.mjs both build the document here.
//
// Implements OpenVEX Specification v0.2.0 (openvex/spec OPENVEX-SPEC.md at commit
// 93139bd2c65390b504e47f82f11c50451289f93a; JSON schema openvex_json_schema_0.2.0.json from the same commit).

export const OPENVEX_CONTEXT = 'https://openvex.dev/ns/v0.2.0';
export const VEX_STATUSES = Object.freeze(['not_affected', 'affected', 'fixed', 'under_investigation']);
export const VEX_JUSTIFICATIONS = Object.freeze([
  'component_not_present',
  'vulnerable_code_not_present',
  'vulnerable_code_not_in_execute_path',
  'vulnerable_code_cannot_be_controlled_by_adversary',
  'inline_mitigations_already_exist',
]);

const DEFAULT_MITIGATION = 'Apply mitigations per vendor instructions.';

/** RFC 3339 UTC timestamp from ms (number, bigint or decimal string), a Date, or an ISO string. */
export function isoTime(value) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return new Date(Number(value)).toISOString();
  if (typeof value === 'number') return new Date(value).toISOString();
  if (typeof value === 'string' && /^\d+$/.test(value)) return new Date(Number(value)).toISOString();
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error(`bad timestamp: ${value}`);
  return d.toISOString();
}

/** The product a KEVIN statement speaks for: the systems operated by one NEAR account. */
export function productId(network, accountId) {
  return `urn:kevin:${network}:systems:${accountId}`;
}

/** One on-chain statement to one OpenVEX statement. The on-chain `mitigated` has no OpenVEX label of its own. */
function toVexStatement({ ticket, statement, requiredAction }, ctx) {
  const at = isoTime(statement.at_ms);
  const base = {
    vulnerability: { '@id': `https://nvd.nist.gov/vuln/detail/${ticket.cve_id}`, name: ticket.cve_id },
    products: [{ '@id': ctx.product }],
    timestamp: at,
  };
  const notes =
    `Answered "${statement.status}" on NEAR ${ctx.network} contract ${ctx.contractId}, ticket #${ticket.id}, ` +
    `before the CISA KEV due date ${ticket.due_date}.`;
  switch (statement.status) {
    case 'not_affected':
      return { ...base, status: 'not_affected', justification: 'component_not_present', status_notes: notes };
    case 'fixed':
      return { ...base, status: 'fixed', status_notes: notes };
    case 'mitigated': {
      const cisa = String(requiredAction ?? ticket.required_action ?? '').trim() || DEFAULT_MITIGATION;
      return {
        ...base,
        status: 'affected',
        action_statement: `Mitigations were applied per the vendor's instructions. CISA required action: ${cisa}`,
        action_statement_timestamp: at,
        status_notes: notes,
      };
    }
    default:
      throw new Error(`unknown on-chain status: ${statement.status}`);
  }
}

/**
 * Build an OpenVEX document for an account.
 * statements: [{ ticket, statement, requiredAction? }] where ticket is the contract's Ticket JSON and
 * statement its Statement JSON ({status, at_ms}). requiredAction (or ticket.required_action) is CISA's
 * requiredAction text, used for `mitigated`. Throws if there is nothing to export, because OpenVEX
 * requires at least one statement.
 */
export function buildOpenVex({ accountId, network = 'testnet', contractId, statements, author, timestamp }) {
  if (!accountId) throw new Error('accountId is required');
  if (!contractId) throw new Error('contractId is required');
  const items = (statements ?? []).filter((s) => s && s.ticket && s.statement);
  if (items.length === 0) throw new Error('nothing to export: this account has no statements yet');
  const issued = isoTime(timestamp ?? Date.now());
  const ctx = { network, contractId, product: productId(network, accountId) };
  const sorted = [...items].sort((a, b) => Number(a.ticket.id) - Number(b.ticket.id));
  return {
    '@context': OPENVEX_CONTEXT,
    '@id': `urn:kevin:${network}:vex:${contractId}:${accountId}:${Date.parse(issued)}`,
    author: author || accountId,
    role: 'Operator of the systems this NEAR account answers for',
    timestamp: issued,
    version: 1,
    tooling: `Kevin from IT (KEVIN), NEAR ${network} contract ${contractId}`,
    statements: sorted.map((s) => toVexStatement(s, ctx)),
  };
}

/**
 * Check a document against the OpenVEX v0.2.0 rules this exporter relies on. Returns a list of problems
 * (empty when valid). Covers the required document and statement fields, the status and justification
 * vocabularies, not_affected needing a justification or impact_statement, affected needing an
 * action_statement, every statement having a product and a timestamp (directly or from the document),
 * and the date-time format of timestamps.
 */
export function validateOpenVex(doc) {
  const errors = [];
  const isTime = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(v);
  if (!doc || typeof doc !== 'object') return ['document is not an object'];
  if (typeof doc['@context'] !== 'string' || !doc['@context'].startsWith('https://openvex.dev/ns/')) errors.push('@context');
  for (const f of ['@id', 'author']) if (typeof doc[f] !== 'string' || !doc[f]) errors.push(`missing ${f}`);
  if (!isTime(doc.timestamp)) errors.push('timestamp is not an RFC 3339 date-time');
  if (!Number.isInteger(doc.version) || doc.version < 1) errors.push('version must be an integer >= 1');
  if (!Array.isArray(doc.statements) || doc.statements.length === 0) {
    errors.push('statements must be a non-empty array');
    return errors;
  }
  doc.statements.forEach((s, i) => {
    const at = `statements[${i}]`;
    if (!s?.vulnerability || typeof s.vulnerability.name !== 'string' || !s.vulnerability.name) errors.push(`${at}.vulnerability.name`);
    if (!VEX_STATUSES.includes(s?.status)) errors.push(`${at}.status`);
    if (s?.status === 'not_affected' && !s.justification && !s.impact_statement) errors.push(`${at} not_affected needs justification or impact_statement`);
    if (s?.justification !== undefined && !VEX_JUSTIFICATIONS.includes(s.justification)) errors.push(`${at}.justification`);
    if (s?.status === 'affected' && !s.action_statement) errors.push(`${at} affected needs action_statement`);
    if (!Array.isArray(s?.products) || s.products.length === 0 || s.products.some((p) => !p?.['@id'] && !p?.identifiers)) {
      errors.push(`${at}.products`);
    }
    for (const f of ['timestamp', 'last_updated', 'action_statement_timestamp']) {
      if (s?.[f] !== undefined && !isTime(s[f])) errors.push(`${at}.${f}`);
    }
  });
  return errors;
}
