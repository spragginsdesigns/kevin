// Offline checks of the chain module: keychain loading, key permission logic, secret hygiene.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import test from 'node:test';
import { KeyPair } from 'near-api-js';
import { chainSettings, credentialFromSecret, loadCredential, permissionAllows } from './chain.mjs';

test('chainSettings reads the environment with testnet defaults', () => {
  assert.deepEqual(chainSettings({}), { network: 'testnet', contractId: 'pager.kevin-it.testnet', rpcs: ['https://test.rpc.fastnear.com', 'https://near-testnet.drpc.org'] });
  assert.deepEqual(chainSettings({ KEVIN_CONTRACT: 'c.testnet', KEVIN_RPC: 'https://a, https://b' }).rpcs, ['https://a', 'https://b']);
  assert.throws(() => chainSettings({ KEVIN_NETWORK: 'betanet' }), /unknown network/);
});

test('permissionAllows reads the RPC access-key shape', () => {
  assert.equal(permissionAllows('FullAccess', 'c', 'x').ok, true);
  const fc = (receiver_id, method_names) => ({ FunctionCall: { allowance: '1', receiver_id, method_names } });
  assert.equal(permissionAllows(fc('c', ['close_ticket']), 'c', 'close_ticket').ok, true);
  assert.equal(permissionAllows(fc('c', ['close_ticket']), 'c', 'ft_transfer').ok, false);
  assert.equal(permissionAllows(fc('other', ['close_ticket']), 'c', 'close_ticket').ok, false);
  assert.equal(permissionAllows(fc('c', []), 'c', 'anything').ok, true);
});

test('loadCredential: both keychain layouts, mismatch detection, and the secret never serializes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kevin-keys-'));
  try {
    const kp = KeyPair.fromRandom('ed25519');
    const secret = kp.toString();
    const file = { account_id: 'a.testnet', public_key: kp.getPublicKey().toString(), private_key: secret };
    await mkdir(join(root, 'testnet'));
    await writeFile(join(root, 'testnet', 'a.testnet.json'), JSON.stringify(file));
    const env = { NEAR_CREDENTIALS_DIR: root };
    const cred = await loadCredential('a.testnet', { network: 'testnet', env });
    assert.equal(cred.publicKey, file.public_key);
    const secretBody = secret.slice('ed25519:'.length);
    assert.doesNotMatch(JSON.stringify(cred), new RegExp(secretBody));
    assert.doesNotMatch(inspect(cred, { depth: 5 }), new RegExp(secretBody));
    assert.ok(cred.keyPair, 'still usable for signing');

    await writeFile(join(root, 'b.testnet.json'), JSON.stringify({ ...file, account_id: 'b.testnet' }));
    assert.equal((await loadCredential('b.testnet', { network: 'testnet', env })).accountId, 'b.testnet');

    const other = KeyPair.fromRandom('ed25519').getPublicKey().toString();
    await writeFile(join(root, 'testnet', 'c.testnet.json'), JSON.stringify({ ...file, account_id: 'c.testnet', public_key: other }));
    await assert.rejects(loadCredential('c.testnet', { network: 'testnet', env }), /does not match/);
    await assert.rejects(loadCredential('missing.testnet', { network: 'testnet', env }), /no key for missing.testnet/);
    assert.throws(() => credentialFromSecret('a.testnet', 'ed25519:notakey'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
