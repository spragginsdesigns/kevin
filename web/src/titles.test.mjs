import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TITLES, titleFor } from './titles.js';

const t = (on_time, missed, streak) => titleFor({ on_time, missed, streak });

test('there are exactly eight titles in the spec order', () => {
  assert.deepEqual(
    TITLES.map((x) => x.name),
    [
      'New Hire',
      'Out of Office',
      'Has Not Restarted the Router',
      'Chief Patch Officer',
      'Senior Patch Goblin',
      'Patch Goblin',
      'Assistant to the Regional Firewall Manager',
      'Helpdesk, Tier 1',
    ],
  );
});

test('New Hire: nothing answered, nothing missed (and a missing desk)', () => {
  assert.equal(t(0, 0, 0), 'New Hire');
  assert.equal(titleFor(null), 'New Hire');
  assert.equal(titleFor({}), 'New Hire');
});

test('Out of Office: nothing answered, at least one miss', () => {
  assert.equal(t(0, 1, 0), 'Out of Office');
  assert.equal(t(0, 40, 0), 'Out of Office');
});

test('Has Not Restarted the Router: more misses than answers, checked before any streak', () => {
  assert.equal(t(1, 2, 0), 'Has Not Restarted the Router');
  assert.equal(t(3, 4, 3), 'Has Not Restarted the Router');
  // equal counts are not "more"
  assert.equal(t(2, 2, 0), 'Assistant to the Regional Firewall Manager');
});

test('Chief Patch Officer: streak of 25 or more and no misses ever', () => {
  assert.equal(t(25, 0, 25), 'Chief Patch Officer');
  assert.equal(t(90, 0, 90), 'Chief Patch Officer');
  assert.equal(t(24, 0, 24), 'Senior Patch Goblin');
  // one miss ever keeps a 25 streak at Senior
  assert.equal(t(40, 1, 30), 'Senior Patch Goblin');
});

test('Senior Patch Goblin: streak 10 to 24, or 25+ with a miss', () => {
  assert.equal(t(10, 0, 10), 'Senior Patch Goblin');
  assert.equal(t(30, 5, 10), 'Senior Patch Goblin');
  assert.equal(t(9, 0, 9), 'Patch Goblin');
});

test('Patch Goblin: streak 3 to 9', () => {
  assert.equal(t(3, 0, 3), 'Patch Goblin');
  assert.equal(t(12, 2, 3), 'Patch Goblin');
  assert.equal(t(2, 0, 2), 'Helpdesk, Tier 1');
});

test('Assistant to the Regional Firewall Manager: some misses, short streak, misses not ahead', () => {
  assert.equal(t(5, 1, 0), 'Assistant to the Regional Firewall Manager');
  assert.equal(t(5, 5, 2), 'Assistant to the Regional Firewall Manager');
});

test('Helpdesk, Tier 1: answered one or two, never missed', () => {
  assert.equal(t(1, 0, 1), 'Helpdesk, Tier 1');
  assert.equal(t(2, 0, 2), 'Helpdesk, Tier 1');
});

test('reads U32 fields whether they arrive as numbers or strings', () => {
  assert.equal(titleFor({ on_time: '30', missed: '0', streak: '30' }), 'Chief Patch Officer');
});
