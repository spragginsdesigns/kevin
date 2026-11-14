// Desk titles, from the lifetime on-chain record only (on_time, missed, streak). One title system:
// My Desk, the leaderboard and the tests all read it from here. Rules are checked top down.
export const TITLES = [
  { name: 'New Hire', when: (r) => r.onTime === 0 && r.missed === 0 },
  { name: 'Out of Office', when: (r) => r.onTime === 0 && r.missed > 0 },
  { name: 'Has Not Restarted the Router', when: (r) => r.missed > r.onTime },
  { name: 'Chief Patch Officer', when: (r) => r.streak >= 25 && r.missed === 0 },
  { name: 'Senior Patch Goblin', when: (r) => r.streak >= 10 },
  { name: 'Patch Goblin', when: (r) => r.streak >= 3 },
  { name: 'Assistant to the Regional Firewall Manager', when: (r) => r.missed > 0 },
  { name: 'Helpdesk, Tier 1', when: () => true },
];

const n = (x) => Number(x ?? 0) || 0;

export function titleFor(desk) {
  const r = { onTime: n(desk?.on_time), missed: n(desk?.missed), streak: n(desk?.streak) };
  return TITLES.find((t) => t.when(r)).name;
}
