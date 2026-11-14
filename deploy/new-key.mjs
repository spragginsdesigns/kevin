// Generate an ed25519 keypair, write it in the near-cli legacy keychain shape, print the public key.
// Usage: node deploy/new-key.mjs <account-id> <out-file>
import { writeFileSync } from "node:fs";
import { KeyPair } from "near-api-js";

const [accountId, outFile] = process.argv.slice(2);
if (!accountId || !outFile) {
  console.error("usage: node deploy/new-key.mjs <account-id> <out-file>");
  process.exit(2);
}
const keyPair = KeyPair.fromRandom("ed25519");
const publicKey = keyPair.getPublicKey().toString();
writeFileSync(outFile, JSON.stringify({ account_id: accountId, public_key: publicKey, private_key: keyPair.toString() }), { mode: 0o600 });
console.log(publicKey);
