#!/usr/bin/env bash
# Put demo accounts on call on one desk: for each account, register it (storage_deposit with the contract's
# storage_balance_bounds().min), claim the starter bag, then go_on_call with the given amount. Steps that are
# already done (registered, starter claimed, already on call) are skipped, so a rerun is safe.
#
#   deploy/demo-setup.sh [--dry-run] <contract> <amount-kevin> <account> [account ...]
#
# Each account signs its own calls with the near-cli legacy keychain, like deploy.sh. --dry-run reads the
# desk state over RPC and prints the near commands it would run; it sends nothing.
set -euo pipefail
DRY_RUN=0
POS=()
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) POS+=("$arg") ;;
  esac
done
[ "${#POS[@]}" -ge 3 ] || { echo "usage: deploy/demo-setup.sh [--dry-run] <contract> <amount-kevin> <account>..." >&2; exit 2; }
CONTRACT="${POS[0]}"; AMOUNT_KEVIN="${POS[1]}"; ACCOUNTS=("${POS[@]:2}")
RPC="${NEAR_RPC:-https://test.rpc.fastnear.com}"

# KEVIN (whole or with up to 18 decimals) to the contract's 18-decimal units.
AMOUNT="$(AMOUNT_KEVIN="$AMOUNT_KEVIN" node -e '
  const s = process.env.AMOUNT_KEVIN;
  if (!/^\d+(\.\d{1,18})?$/.test(s)) { console.error(`amount must be a number of KEVIN, got ${s}`); process.exit(2); }
  const [w, f = ""] = s.split(".");
  const v = BigInt(w) * 10n ** 18n + BigInt(f.padEnd(18, "0"));
  if (v === 0n) { console.error("amount must be positive"); process.exit(2); }
  console.log(v.toString());
')"

# view <method> <json-args>: prints the JSON result, or nothing if the call fails.
view() {
  local args_b64
  args_b64="$(printf '%s' "$2" | base64 | tr -d '\n')"
  curl -sS --max-time 20 "$RPC" -H 'content-type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"call_function\",\"finality\":\"final\",\"account_id\":\"$CONTRACT\",\"method_name\":\"$1\",\"args_base64\":\"$args_b64\"}}" \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const r=JSON.parse(s).result;if(r&&r.result)console.log(Buffer.from(r.result).toString())}catch{}})' \
    || true
}

# field <json> <name>: one top-level field of a JSON value ("" when missing or when the JSON is "null").
field() {
  JSON_IN="$1" node -e 'const v=JSON.parse(process.env.JSON_IN||"null");const x=v?.[process.argv[1]];console.log(x===undefined||x===null?"":String(x))' "$2"
}

run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf 'WOULD RUN'; printf ' %q' "$@"; printf '\n'
  else
    "$@"
  fi
}

BOUNDS="$(view storage_balance_bounds '{}')"
MIN_DEPOSIT="$(field "$BOUNDS" min)"
CONFIG="$(view get_config '{}')"
MIN_COMMIT="$(field "$CONFIG" min_commit)"
if [ -z "$MIN_DEPOSIT" ]; then
  [ "$DRY_RUN" -eq 1 ] || { echo "cannot read storage_balance_bounds on $CONTRACT from $RPC"; exit 1; }
  echo "WARN cannot read $CONTRACT; dry run prints every step with a placeholder deposit"
  MIN_DEPOSIT="<storage_balance_bounds.min>"
fi
if [ -n "$MIN_COMMIT" ] && [ "$(node -e 'console.log(BigInt(process.argv[1]) < BigInt(process.argv[2]))' "$AMOUNT" "$MIN_COMMIT")" = "true" ]; then
  echo "WARN $AMOUNT_KEVIN KEVIN is below this desk's min_commit ($MIN_COMMIT); go_on_call will be refused for accounts not on call yet"
fi
echo "desk $CONTRACT: commit $AMOUNT_KEVIN KEVIN ($AMOUNT) for ${#ACCOUNTS[@]} account(s)$([ "$DRY_RUN" -eq 1 ] && echo '; dry run')"

call() { # call <signer> <method> <json-args> <deposit>
  run near contract call-function as-transaction "$CONTRACT" "$2" json-args "$3" \
    prepaid-gas '50 Tgas' attached-deposit "$4" sign-as "$1" network-config testnet sign-with-legacy-keychain send
}

for ACCOUNT in "${ACCOUNTS[@]}"; do
  STORAGE="$(view storage_balance_of "{\"account_id\":\"$ACCOUNT\"}")"
  DESK="$(view get_desk "{\"account_id\":\"$ACCOUNT\"}")"
  if [ -n "$(field "$STORAGE" total)" ]; then
    echo "$ACCOUNT: registered"
  else
    echo "$ACCOUNT: register"
    call "$ACCOUNT" storage_deposit "{\"account_id\":\"$ACCOUNT\",\"registration_only\":true}" "$MIN_DEPOSIT yoctoNEAR"
  fi
  if [ "$(field "$DESK" claimed_starter)" = "true" ]; then
    echo "$ACCOUNT: starter bag already claimed"
  else
    echo "$ACCOUNT: claim the starter bag"
    call "$ACCOUNT" claim_starter '{}' '0 NEAR'
  fi
  if [ "$(field "$DESK" on_call)" = "true" ]; then
    echo "$ACCOUNT: already on call (committed $(field "$DESK" committed))"
  else
    echo "$ACCOUNT: go on call with $AMOUNT_KEVIN KEVIN"
    # go_on_call takes exactly 1 yoctoNEAR, so only a full-access key can commit tokens
    call "$ACCOUNT" go_on_call "{\"amount\":\"$AMOUNT\"}" '1 yoctoNEAR'
  fi
done
