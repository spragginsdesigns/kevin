#!/usr/bin/env bash
# One upkeep round for a live desk and a drill desk. Meant for a timer (every 15 minutes).
#
#   1. drill desk: open the next fire-drill ticket (10 minute deadline)
#   2. both desks: the demo on-call bot answers every open ticket for its account
#   3. both desks: expire tickets and settle the demo accounts and every on-call desk on the roster that owes
#      a burn, so supply shows the burns
#   4. live desk, first round of each hour: the reporters read CISA's catalog and open new tickets
#
# Everything comes from the environment; nothing here is specific to one machine:
#
#   KEVIN_LIVE, KEVIN_DRILL                   contract accounts
#   KEVIN_LIVE_REPORTERS, KEVIN_DRILL_REPORTERS   comma separated reporter accounts
#   KEVIN_UPKEEP_SIGNER                       any funded account; pays gas for poke and settle
#   KEVIN_DEMO_ACCOUNTS                       space separated accounts to settle each round (on top of the roster)
#   KEVIN_ONCALL_ACCOUNT                      the demo account the on-call bot answers for (optional)
#   KEVIN_ONCALL_KEY_LIVE, KEVIN_ONCALL_KEY_DRILL  its on-call key files, one per desk (optional)
#   KEVIN_PARTTIME_ACCOUNT, KEVIN_PARTTIME_KEY_DRILL  a second demo account whose bot answers only every other
#                                             drill round (optional)
#   NEAR_CREDENTIALS_DIR                      keychain root holding the reporter and signer keys
#
# A failing step does not stop the round; the exit code is the number of steps that failed.
set -u
cd "$(dirname "$0")/.."
: "${KEVIN_LIVE:?}" "${KEVIN_DRILL:?}" "${KEVIN_LIVE_REPORTERS:?}" "${KEVIN_DRILL_REPORTERS:?}" "${KEVIN_UPKEEP_SIGNER:?}"
DEMO="${KEVIN_DEMO_ACCOUNTS:-}"
EMPTY_INVENTORY="$(mktemp)"; echo '[]' > "$EMPTY_INVENTORY"; trap 'rm -f "$EMPTY_INVENTORY"' EXIT
failed=0
step() { echo "--- $(date -u +%FT%TZ) $1"; shift; "$@" || { echo "step failed: exit $?"; failed=$((failed + 1)); }; }

step "drill: open the next ticket" env KEVIN_CONTRACT="$KEVIN_DRILL" KEVIN_REPORTERS="$KEVIN_DRILL_REPORTERS" \
  node scripts/drill.mjs --count 1 --minutes 10

if [ -n "${KEVIN_ONCALL_ACCOUNT:-}" ]; then
  [ -n "${KEVIN_ONCALL_KEY_DRILL:-}" ] && step "drill: on-call bot" env KEVIN_CONTRACT="$KEVIN_DRILL" \
    node scripts/oncall.mjs --account "$KEVIN_ONCALL_ACCOUNT" --key-file "$KEVIN_ONCALL_KEY_DRILL" --inventory "$EMPTY_INVENTORY"
  [ -n "${KEVIN_ONCALL_KEY_LIVE:-}" ] && step "live: on-call bot" env KEVIN_CONTRACT="$KEVIN_LIVE" \
    node scripts/oncall.mjs --account "$KEVIN_ONCALL_ACCOUNT" --key-file "$KEVIN_ONCALL_KEY_LIVE" --inventory "$EMPTY_INVENTORY"
fi

# Optional second demo desk: its bot only turns up for every other round (the rounds on the hour and half
# hour), so the board shows a desk with both answers and misses.
if [ -n "${KEVIN_PARTTIME_ACCOUNT:-}" ] && [ -n "${KEVIN_PARTTIME_KEY_DRILL:-}" ] && [ $(( 10#$(date -u +%M) / 15 % 2 )) -eq 0 ]; then
  step "drill: part-time bot" env KEVIN_CONTRACT="$KEVIN_DRILL" \
    node scripts/oncall.mjs --account "$KEVIN_PARTTIME_ACCOUNT" --key-file "$KEVIN_PARTTIME_KEY_DRILL" --inventory "$EMPTY_INVENTORY"
fi

# shellcheck disable=SC2086
step "drill: expire and settle" env KEVIN_CONTRACT="$KEVIN_DRILL" node scripts/janitor.mjs --signer "$KEVIN_UPKEEP_SIGNER" --roster $DEMO
# shellcheck disable=SC2086
step "live: expire and settle" env KEVIN_CONTRACT="$KEVIN_LIVE" node scripts/janitor.mjs --signer "$KEVIN_UPKEEP_SIGNER" --roster $DEMO

if [ "$(date -u +%M)" -lt 15 ]; then
  step "live: reporters" env KEVIN_CONTRACT="$KEVIN_LIVE" KEVIN_REPORTERS="$KEVIN_LIVE_REPORTERS" node scripts/reporter.mjs
fi

exit "$failed"
