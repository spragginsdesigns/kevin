#!/usr/bin/env bash
# Make an account keyless: delete every access key it has. After this nobody can redeploy the
# contract, change its state outside its own methods, or move its NEAR.
#
#   deploy/lock.sh <account>
set -euo pipefail
ACCOUNT="${1:?account}"
RPC="${NEAR_RPC:-https://test.rpc.fastnear.com}"
KEYS="$(curl -sS "$RPC" -H 'content-type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"view_access_key_list\",\"finality\":\"final\",\"account_id\":\"$ACCOUNT\"}}" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const k=JSON.parse(s).result.keys.map(k=>k.public_key);console.log(k.join(","))})')"
[ -n "$KEYS" ] || { echo "$ACCOUNT already has no keys"; exit 0; }
echo "deleting keys of $ACCOUNT: $KEYS"
near account delete-keys "$ACCOUNT" public-keys "$KEYS" network-config testnet sign-with-legacy-keychain send
curl -sS "$RPC" -H 'content-type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"view_access_key_list\",\"finality\":\"final\",\"account_id\":\"$ACCOUNT\"}}"
echo
