// Contract accounts and network endpoints. See deploy/deployments.json for the deployed ids.
// v2 (the On-Call Program). The v1 desks, coin. and drill.kevin-it.testnet, stay up as the earlier version.
export const CONTRACT_ID = import.meta.env?.VITE_CONTRACT_ID || 'pager.kevin-it.testnet';
export const DRILL_CONTRACT_ID = import.meta.env?.VITE_DRILL_CONTRACT_ID || 'firedrill.kevin-it.testnet';

export const NETWORK_ID = 'testnet';
// Both answer browsers with access-control-allow-origin: *.
export const RPC_URLS = ['https://test.rpc.fastnear.com', 'https://near-testnet.drpc.org'];
// Public testnet faucet helper. Request shape matches near-cli-rs
// (sponsor_by_faucet_service: POST JSON {newAccountId, newAccountPublicKey}).
export const FAUCET_URL = 'https://helper.nearprotocol.com/account';
export const GUEST_SUFFIX = '.testnet';

export const EXPLORER_ACCOUNT = 'https://testnet.nearblocks.io/address/';
export const EXPLORER_TX = 'https://testnet.nearblocks.io/txns/';

export const KEV_MIRROR = 'https://raw.githubusercontent.com/cisagov/kev-data/develop/known_exploited_vulnerabilities.json';
export const CISA_KEV_PAGE = 'https://www.cisa.gov/known-exploited-vulnerabilities-catalog';
export const NVD_URL = (cve) => `https://nvd.nist.gov/vuln/detail/${cve}`;
export const CISA_SEARCH_URL = (cve) => `${CISA_KEV_PAGE}?search_api_fulltext=${encodeURIComponent(cve)}`;
// The README's trust-limits section, linked from the footer.
export const README_URL = import.meta.env?.VITE_README_URL || 'https://github.com/spragginsdesigns/kevin#trust-limits';

export const TOKEN_DECIMALS = 18;
export const TOKEN_SYMBOL = 'KEVIN';

// The periodic tick reads only get_stats; everything else reloads when stats change, when a deadline
// passes, on first load, on tab focus and after the user's own writes. The drill desk ticks faster.
export const REFRESH_MS = { live: 30_000, drill: 10_000 };

export const DESKS = {
  live: { key: 'live', contractId: CONTRACT_ID, label: 'Live desk' },
  drill: { key: 'drill', contractId: DRILL_CONTRACT_ID, label: 'Fire drill' },
};

// Two always-on demo desks, registered on both contracts, shown side by side above the queue.
export const DEMO_ACCOUNTS = [
  { id: 'bob.kevin-it.testnet', label: 'On-call bot', note: 'runs npm run oncall, answers every ticket' },
  { id: 'ghost.kevin-it.testnet', label: 'Never answers', note: 'silent on every ticket' },
];

// Fire drill cadence: a new drill ticket on every quarter hour (UTC), due 10 minutes later.
export const DRILL_SCHEDULE = {
  everyMinutes: 15,
  deadlineMinutes: 10,
  lastDayUtc: '2026-11-19',
  text: 'A new drill ticket opens every 15 minutes, on the quarter hour (UTC), with a 10 minute deadline, through Nov 19.',
};
