#!/usr/bin/env bash
# Give a reporter account a function-call key that can only call report_ticket on one contract,
# then (optionally, with --only) delete every other key so that is all the account can ever do.
#
#   deploy/reporter-key.sh <reporter-account> <contract-account> <key-dir> [--only]
#
# The new key is written to <key-dir>/<reporter-account>.json in the near-cli legacy keychain shape.
set -euo pipefail
REPORTER="${1:?reporter account}"; CONTRACT="${2:?contract account}"; KEYDIR="${3:?key dir}"; ONLY="${4:-}"
RPC="${NEAR_RPC:-https://test.rpc.fastnear.com}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$KEYDIR"; chmod 700 "$KEYDIR"
PUB="$(cd "$ROOT" && node deploy/new-key.mjs "$REPORTER" "$KEYDIR/$REPORTER.json")"
near account add-key "$REPORTER" grant-function-call-access --allowance unlimited \
  --contract-account-id "$CONTRACT" --function-names report_ticket \
  use-manually-provided-public-key "$PUB" network-config testnet sign-with-legacy-keychain send
if [ "$ONLY" = "--only" ]; then
  OTHERS="$(curl -sS "$RPC" -H 'content-type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"view_access_key_list\",\"finality\":\"final\",\"account_id\":\"$REPORTER\"}}" \
    | PUB="$PUB" node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const k=JSON.parse(s).result.keys.map(k=>k.public_key).filter(k=>k!==process.env.PUB);console.log(k.join(","))})')"
  if [ -n "$OTHERS" ]; then
    near account delete-keys "$REPORTER" public-keys "$OTHERS" network-config testnet sign-with-legacy-keychain send
  fi
fi
echo "reporter $REPORTER key: $PUB (report_ticket on $CONTRACT only)"
