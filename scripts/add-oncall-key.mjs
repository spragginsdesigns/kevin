#!/usr/bin/env node
// Mint the on-call key: a FUNCTION-CALL access key on your account that may only call close_ticket on the
// KEVIN contract. A bot holding it can keep you answered but cannot transfer your tokens.

import { chmod, mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { KeyPair, nearToYocto } from 'near-api-js';
import { parseCli, runMain, usage } from '../lib/cli.mjs';
import { KevinChain, chainSettings, loadCredential } from '../lib/chain.mjs';

const HELP = `
Usage: node scripts/add-oncall-key.mjs --account <id> [options]

Generates a new ed25519 key pair, adds it to <id> as a function-call key limited to close_ticket on the
contract (signed with <id>'s full-access key from the near-cli keychain), and saves it to .kevin/oncall.json
(mode 600) for npm run oncall. Prints only the public key.

Environment: KEVIN_CONTRACT (default pager.kevin-it.testnet), KEVIN_NETWORK, KEVIN_RPC, NEAR_CREDENTIALS_DIR.

Options:
  --account <id>          the holder account (required)
  --allowance-near <n>    gas allowance for the key in NEAR (default 0.25)
  --out <path>            where to save the key (default .kevin/oncall.json)
  --force                 overwrite an existing key file
  --dry-run               check the signing key and build the unsigned add-key transaction; writes nothing
  -h, --help              show this help

Exit codes: 0 ok, 1 error, 2 bad arguments.
`;

runMain(async () => {
  const { values } = parseCli(HELP, {
    account: { type: 'string' },
    'allowance-near': { type: 'string' },
    out: { type: 'string' },
    force: { type: 'boolean' },
    'dry-run': { type: 'boolean' },
  });
  if (!values.account) usage('--account is required');
  const out = values.out ?? '.kevin/oncall.json';
  const exists = await stat(out).then(() => true, () => false);
  if (exists && !values.force && !values['dry-run']) usage(`${out} exists; pass --force to replace it`);
  const allowanceYocto = nearToYocto(values['allowance-near'] ?? '0.25');

  const settings = chainSettings();
  const chain = new KevinChain(settings);
  const cred = await loadCredential(values.account, { network: settings.network });
  const keyPair = KeyPair.fromRandom('ed25519');
  const publicKey = keyPair.getPublicKey().toString();
  const result = await chain.addFunctionCallKey(cred, publicKey, {
    methodNames: ['close_ticket'],
    allowanceYocto,
    dryRun: Boolean(values['dry-run']),
  });
  if (result.dryRun) {
    console.log(`WOULD ADD to ${values.account}: function-call key ${publicKey} for ${settings.contractId} [close_ticket], ` +
      `allowance ${allowanceYocto} yoctoNEAR; signer key is full access, nonce ${result.nonce}. Nothing written.`);
    return 0;
  }
  await mkdir(dirname(out), { recursive: true, mode: 0o700 });
  const file = {
    account_id: values.account,
    public_key: publicKey,
    private_key: keyPair.toString(),
    contract_id: settings.contractId,
    network: settings.network,
    method_names: ['close_ticket'],
  };
  await writeFile(out, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  await chmod(out, 0o600);
  console.log(`added on-call key ${publicKey} to ${values.account} (close_ticket on ${settings.contractId})`);
  console.log(`tx ${chain.explorerTx(result.txHash)}`);
  console.log(`saved to ${out}; run: npm run oncall -- --inventory scripts/inventory.example.json --dry-run`);
  return 0;
});
