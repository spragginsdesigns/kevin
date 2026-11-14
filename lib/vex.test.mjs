import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { OPENVEX_CONTEXT, buildOpenVex, productId, validateOpenVex } from './vex.mjs';

const ticket = (id, cve) => ({ id, cve_id: cve, vendor: 'V', product: 'P', date_added: '2026-11-10', due_date: '2026-11-24', ransomware: false, deadline_ms: '1795564799000' });
const input = {
  accountId: 'alice.testnet',
  network: 'testnet',
  contractId: 'pager.kevin-it.testnet',
  timestamp: '2026-11-13T21:00:00Z',
  statements: [
    { ticket: ticket(2, 'CVE-2026-0003'), statement: { status: 'mitigated', at_ms: '1794600000000' }, requiredAction: 'Apply updates per vendor instructions.' },
    { ticket: ticket(0, 'CVE-2026-0001'), statement: { status: 'not_affected', at_ms: '1794500000000' } },
    { ticket: ticket(1, 'CVE-2026-0002'), statement: { status: 'fixed', at_ms: '1794550000000' } },
  ],
};

test('document carries every field OpenVEX v0.2.0 requires', () => {
  const doc = buildOpenVex(input);
  assert.equal(doc['@context'], OPENVEX_CONTEXT);
  assert.equal(doc['@context'], 'https://openvex.dev/ns/v0.2.0');
  assert.ok(doc['@id'].startsWith('urn:'));
  assert.equal(doc.author, 'alice.testnet');
  assert.equal(doc.timestamp, '2026-11-13T21:00:00.000Z');
  assert.equal(doc.version, 1);
  assert.deepEqual(validateOpenVex(doc), []);
});

test('status mapping: not_affected, fixed, mitigated -> affected with action_statement', () => {
  const [na, fx, mi] = buildOpenVex(input).statements; // sorted by ticket id
  assert.equal(na.vulnerability.name, 'CVE-2026-0001');
  assert.equal(na.status, 'not_affected');
  assert.equal(na.justification, 'component_not_present');
  assert.equal(fx.status, 'fixed');
  assert.equal(fx.justification, undefined);
  assert.equal(mi.status, 'affected');
  assert.match(mi.action_statement, /vendor's instructions/);
  assert.match(mi.action_statement, /Apply updates per vendor instructions\./);
  assert.equal(mi.action_statement_timestamp, mi.timestamp);
  assert.equal(na.timestamp, new Date(1794500000000).toISOString());
  for (const s of [na, fx, mi]) {
    assert.deepEqual(s.products, [{ '@id': productId('testnet', 'alice.testnet') }]);
    assert.equal(s.vulnerability['@id'], `https://nvd.nist.gov/vuln/detail/${s.vulnerability.name}`);
  }
});

test('validator enforces the spec rules it claims to', () => {
  const doc = buildOpenVex(input);
  const broken = structuredClone(doc);
  delete broken.statements[0].justification;
  broken.statements[2].action_statement = '';
  broken.statements[1].status = 'patched';
  broken.statements[1].products = [];
  broken.version = 0;
  delete broken.author;
  const errors = validateOpenVex(broken);
  assert.ok(errors.some((e) => /not_affected needs justification/.test(e)));
  assert.ok(errors.some((e) => /affected needs action_statement/.test(e)));
  assert.ok(errors.some((e) => /statements\[1\]\.status/.test(e)));
  assert.ok(errors.some((e) => /statements\[1\]\.products/.test(e)));
  assert.ok(errors.includes('version must be an integer >= 1'));
  assert.ok(errors.includes('missing author'));
  const withImpact = structuredClone(doc);
  delete withImpact.statements[0].justification;
  withImpact.statements[0].impact_statement = 'Not installed anywhere we operate.';
  assert.deepEqual(validateOpenVex(withImpact), []);
});

test('nothing to export throws: OpenVEX needs at least one statement', () => {
  assert.throws(() => buildOpenVex({ ...input, statements: [] }), /no statements/);
  assert.throws(() => buildOpenVex({ ...input, statements: [{ ticket: ticket(0, 'CVE-2026-0001'), statement: null }] }), /no statements/);
});

test('deterministic for a fixed timestamp, and browser-safe (no Node imports)', async () => {
  assert.equal(JSON.stringify(buildOpenVex(input)), JSON.stringify(buildOpenVex(structuredClone(input))));
  const src = await readFile(new URL('./vex.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /^\s*import\b/m);
  assert.doesNotMatch(src, /\bprocess\.|require\(/);
});
