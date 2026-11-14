# Hosting and upkeep

Nothing in this repository is hosted by default. This file lists what a person needs to run to put the web app
online and to keep the two testnet desks alive through judging.

## The web app (static)

```
npm ci
npm run build        # writes dist/
```

`dist/` is a static site with relative asset paths, so it works from any path on any static host. It has no
backend: it reads NEAR testnet over public RPC and the guest desk creates its account through the public
testnet faucet from the browser.

GitHub Pages, once the repository is public:

1. Settings, Pages, Source: "GitHub Actions".
2. Actions, "Publish web app to Pages", Run workflow.

The contract accounts are compiled in from `web/src/config.js`. To point a build at other deployments set
`VITE_CONTRACT_ID` and `VITE_DRILL_CONTRACT_ID` at build time.

## The reporter (opens tickets)

Tickets only appear when the reporter accounts send them. One round:

```
KEVIN_CONTRACT=<live contract> KEVIN_REPORTERS=<r1>,<r2>,<r3> NEAR_CREDENTIALS_DIR=<dir with the reporter keys> npm run reporter
```

It reads CISA's catalog, skips what is already on the desk and is safe to run twice. Run it on a timer (hourly
is plenty: CISA adds entries a few times a week). Each reporter account signs with a function-call key that can
only call `report_ticket` on that contract, so the machine that runs the timer holds no key that can move
anything.

## The janitor (expires and settles)

Burns show up in `ft_total_supply` only when desks are settled. Any account can do it for any other. `--roster`
settles every desk that has ever taken the pager:

```
KEVIN_CONTRACT=<contract> npm run janitor -- --signer <any funded testnet account> --roster
```

Run it on the same timer as the drill. It also keeps the Employee of the Month board cheap to read: `get_roster`
projects each desk's pending burns, which costs more view gas the longer a desk goes unsettled.

## Demo desks

```
deploy/demo-setup.sh <contract> 5000 <account> [<account> ...]
```

registers each account, claims its starter bag and puts it on call with 5,000 KEVIN committed (`--dry-run`
prints the commands). `node scripts/add-oncall-key.mjs --account <account>` then adds an answer-only key for
`npm run oncall`.

## The fire drill

```
KEVIN_CONTRACT=<drill contract> KEVIN_REPORTERS=<d1>,<d2> npm run drill -- --count 2 --minutes 4
```

opens two tickets from the past with a deadline four minutes away. Run it whenever a fresh drill is wanted, or on
a timer so a visitor always finds a deadline close by.

## Testnet NEAR budget

Measured on testnet with this code:

- Registering an account on a desk: 0.07881 NEAR storage deposit. Desks are permanent, so it is not refunded.
- A `report_ticket` or `close_ticket` call burns under 0.001 NEAR of gas.
- A reporter account running hourly for two weeks spends well under 0.5 NEAR. Fund each with 1 NEAR.
- The contract account pays for ticket and overflow statement storage: keep 2 NEAR of headroom on it.

Testnet NEAR is free from the public faucet (`near account create-account sponsor-by-faucet-service ...`).
