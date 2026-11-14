#!/usr/bin/env bash
# Deploy one Kevin desk to NEAR testnet.
#
#   deploy/deploy.sh <contract-account> <operator-account> <reporters-csv> <quorum> <min-window-ms> [fund-near]
#
# The contract account is created as a sub-account of the operator, funded, deployed and initialised in
# one go. Nothing here removes keys: run deploy/lock.sh afterwards to make the contract keyless.
set -euo pipefail
CONTRACT="${1:?contract account}"; OPERATOR="${2:?operator account}"; REPORTERS="${3:?reporters csv}"
QUORUM="${4:?quorum}"; MIN_WINDOW_MS="${5:?min window ms}"; FUND="${6:-6}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WASM="${KEVIN_WASM:-$ROOT/contract/res/kevin.wasm}"
[ -f "$WASM" ] || { echo "wasm not found at $WASM"; exit 1; }

# 1,000,000,000 KEVIN and a 10,000 KEVIN starter bag, 18 decimals.
INITIAL_SUPPLY="${KEVIN_INITIAL_SUPPLY:-1000000000000000000000000000}"
STARTER_BAG="${KEVIN_STARTER_BAG:-10000000000000000000000}"
MISS_BPS="${KEVIN_MISS_BPS:-100}"; RANSOM_MISS_BPS="${KEVIN_RANSOM_MISS_BPS:-500}"; MAX_OPEN="${KEVIN_MAX_OPEN:-128}"
# v2: the smallest commitment that starts an on-call stint (1,000 KEVIN) and the minimum shift length
# (7 days; the fire drill uses 1800000, 30 minutes).
MIN_COMMIT="${KEVIN_MIN_COMMIT:-1000000000000000000000}"; MIN_SHIFT_MS="${KEVIN_MIN_SHIFT_MS:-604800000}"

REPORTERS_JSON="$(printf '%s' "$REPORTERS" | awk -F, '{printf "["; for(i=1;i<=NF;i++){printf "%s\"%s\"", (i>1?",":""), $i}; printf "]"}')"
ARGS="{\"reporters\":$REPORTERS_JSON,\"quorum\":$QUORUM,\"miss_bps\":$MISS_BPS,\"ransom_miss_bps\":$RANSOM_MISS_BPS,\"min_window_ms\":\"$MIN_WINDOW_MS\",\"max_open\":$MAX_OPEN,\"starter_bag\":\"$STARTER_BAG\",\"initial_supply\":\"$INITIAL_SUPPLY\",\"min_commit\":\"$MIN_COMMIT\",\"min_shift_ms\":\"$MIN_SHIFT_MS\"}"

echo "wasm: $WASM ($(wc -c < "$WASM") bytes, sha256 $(sha256sum "$WASM" | cut -d' ' -f1))"
echo "init: $ARGS"

near account create-account fund-myself "$CONTRACT" "$FUND NEAR" autogenerate-new-keypair save-to-legacy-keychain \
  sign-as "$OPERATOR" network-config testnet sign-with-legacy-keychain send

near contract deploy "$CONTRACT" use-file "$WASM" with-init-call new json-args "$ARGS" \
  prepaid-gas '100 Tgas' attached-deposit '0 NEAR' network-config testnet sign-with-legacy-keychain send

near contract call-function as-read-only "$CONTRACT" get_config json-args '{}' network-config testnet now
