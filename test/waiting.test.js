import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ISSUE_STATUS, OPEN_ISSUE_STATUSES, daysSince, formatWaiting } from '../shared/domain.js';

const NOW = Date.parse('2026-08-26T12:00:00Z');

test('daysSince counts whole days from a stored timestamp', () => {
  assert.equal(daysSince('2026-08-26 11:00:00', NOW), 0);
  assert.equal(daysSince('2026-08-25 11:00:00', NOW), 1);
  assert.equal(daysSince('2026-07-27 12:00:00', NOW), 30);
  // The database writes "YYYY-MM-DD HH:MM:SS" in UTC with no marker.
  assert.equal(daysSince('2026-08-24T12:00:00Z', NOW), 2);
});

test('daysSince has no opinion about a missing or unreadable value', () => {
  assert.equal(daysSince(null, NOW), null);
  assert.equal(daysSince('', NOW), null);
  assert.equal(daysSince('not a date', NOW), null);
});

test('a clock skew does not produce a negative wait', () => {
  assert.equal(daysSince('2026-08-27 12:00:00', NOW), 0);
});

test('formatWaiting says it the way somebody would', () => {
  assert.equal(formatWaiting('2026-08-26 09:00:00', NOW), 'since today');
  assert.equal(formatWaiting('2026-08-25 09:00:00', NOW), 'since yesterday');
  assert.equal(formatWaiting('2026-08-21 09:00:00', NOW), 'for 5 days');
  assert.equal(formatWaiting('2026-08-05 12:00:00', NOW), 'for 3 weeks');
  assert.equal(formatWaiting('2026-05-26 12:00:00', NOW), 'for 3 months');
  assert.equal(formatWaiting(null, NOW), '');
});

test('blocked is open work, not closed work', () => {
  // It has to count toward "open" everywhere, or a blocked issue disappears
  // from every total and nobody chases it again.
  assert.equal(ISSUE_STATUS.blocked.terminal, false);
  assert.ok(OPEN_ISSUE_STATUSES.includes('blocked'));
  assert.deepEqual(
    OPEN_ISSUE_STATUSES,
    ['open', 'in_progress', 'blocked', 'ready_for_qa'],
    'the open statuses, in the order the loop runs'
  );
});
