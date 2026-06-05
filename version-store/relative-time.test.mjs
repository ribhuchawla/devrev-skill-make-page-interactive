import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatRelativeTime } from './relative-time.mjs';

// Fixed "now": 2026-06-04T15:30:00 local.
const now = new Date('2026-06-04T15:30:00');
const at = (iso) => formatRelativeTime(iso, now);

test('under 1 minute -> just now', () => {
  assert.equal(at('2026-06-04T15:29:30'), 'just now');
});

test('1-30 minutes -> N min ago', () => {
  assert.equal(at('2026-06-04T15:25:00'), '5 min ago');
  assert.equal(at('2026-06-04T15:00:00'), '30 min ago');
});

test('same day older than 30 min -> today, h:mm AM/PM', () => {
  assert.equal(at('2026-06-04T12:30:00'), 'today, 12:30 PM');
  assert.equal(at('2026-06-04T09:05:00'), 'today, 9:05 AM');
});

test('previous calendar day -> yesterday, h:mm AM/PM', () => {
  assert.equal(at('2026-06-03T23:15:00'), 'yesterday, 11:15 PM');
});

test('older -> Mon D, h:mm AM/PM', () => {
  assert.equal(at('2026-06-02T09:13:00'), 'Jun 2, 9:13 AM');
});
