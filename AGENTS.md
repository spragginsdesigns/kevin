# Working guide for coding agents

Read `README.md` first. This file is the short version for an agent that has to check or change the project.

## What this is

KEVIN is a NEP-141 token on NEAR testnet. Reporter accounts open one ticket per entry in CISA's Known Exploited
Vulnerabilities catalog. Holding the token asks nothing: the free balance never burns. A desk that calls
`go_on_call(amount)` commits tokens for a shift and must call `close_ticket` on every ticket before its deadline;
a miss burns 1% (5% for ransomware-flagged entries) of what it committed when the desk is settled. `clock_out`
returns the tokens once the shift is over and every open ticket is answered. `get_roster` backs the Employee of
the Month board, and `web/src/kevinSays.js` holds every line Kevin says.

## Checking it, fastest first

| Seconds | Command | What it proves |
|---|---|---|
| 1 | `npm run sim` | The five-year replay table in the README, from `data/kev-snapshot.json` |
| 5 | `npm test` | The model of the contract's rules, the replay calendars, bots, OpenVEX export, roster order, titles and Kevin's lines |
| 8 | `npm run claims` | The README's replay table, drill numbers and Node test count equal what the code computes |
| 20 | `npm run claims -- --live` | The testnet claims: configuration, keyless contracts, reporter keys, code hash, tickets against CISA's catalog, the recorded fire drill, the roster, a holder that was never burned, every linked transaction |
| 60 | `npm run dev`, open `http://localhost:4150/?mock=1` | The whole UI with no network |
| minutes | `cd contract && cargo test` | The contract: unit tests and near-sandbox tests on the built wasm |

`npm ci` first. Node 22 or newer. Nothing needs a key, an account or an AI call. `--live` and the default web app
read public testnet RPC; the guest desk in the web app creates its own faucet account in the browser.

## Layout

- `contract/src/`: `tickets.rs` (reports, quorum, answers), `oncall.rs` (`go_on_call`, `clock_out`), `expiry.rs`,
  `settle.rs` (the burn rule, from the committed amount), `month.rs` (the UTC month counters), `token.rs` (plain
  NEP-141 on the free balance), `storage.rs` (NEP-145, permanent desks), `views.rs`, `events.rs`.
  `contract/tests/sandbox.rs` has one test per cheat in the README. `contract/res/kevin.wasm` is the deployed build.
- `lib/model.mjs`: the same rule in BigInt. If you change the contract's settlement or expiry order, change the
  model and `web/src/mockChain.js` too. Nothing compares the three automatically: `npm run claims` C6 checks the model
  against one recorded testnet round only.
- `scripts/`: one file per command in `package.json`.
- `web/src/`: `chain.js` (real adapter), `mockChain.js` (in-memory rules), `kevinSays.js` (every line Kevin says,
  as pure functions), `titles.js`, `roster.js`, `components/`. `web/proof/` has the browser walks: `oncall-walk.mjs`
  against `?mock=1`, `real-chain.mjs` against testnet.
- `deploy/deployments.json`: the deployed accounts and the recorded drill; `claims --live` reads it. `first_version`
  names the earlier deployment (every holder liable), which is still on testnet and is not used.

## Rules of the repository

- Never commit a key. Keys live outside the repository; `.gitignore` covers `.kevin/`, `.env` and `*.key.json`.
- Every number in `README.md` must be produced by code here. Add a claim to `scripts/claims.mjs` when you add a
  number it can compute; the contract test counts and gas figures come from `cargo test` and are not checked.
- The deployed contracts are keyless and cannot be changed. A contract change means a new deployment and new
  account ids in `web/src/config.js`, `lib/chain.mjs`, `deploy/deployments.json` and the README.
- Do not send transactions on mainnet. Everything here is testnet.
- Plain language in docs, no marketing. Kevin's jokes live in `web/src/kevinSays.js` and nowhere else: every number,
  CVE id, product and date in a line must come from the function's arguments, and each rule needs a test.
- `go_on_call` and `clock_out` take exactly 1 yoctoNEAR. Any new caller must attach it and sign with a full-access key.

## Known sharp edges

- The near-sandbox tests need glibc 2.39 and take about six minutes; under heavy load run them with
  `cargo test --test sandbox -- --test-threads=4`.
- The web app polls public RPC. If an endpoint rate limits, the app keeps the last data and retries.
- `npm run reporter`, `oncall`, `janitor` and `drill` sign transactions and need keys you provide; each has
  `--dry-run`.
