import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isIsoUtcInstant, unansweredActivities } from './activity-review.js';

const items = [
  { id: 'earlier', title: 'Water', time: '09:00', state: 'upcoming' },
  { id: 'same-time', title: 'Meal', time: '12:00', state: 'upcoming' },
  { id: 'later', title: 'Walk', time: '15:00', state: 'upcoming' },
  { id: 'acknowledged', title: 'Tablet', time: '08:00', state: 'acknowledged' },
  { id: 'postponed', title: 'Call', time: '10:00', state: 'postponed' },
];

test('care review uses the supplied local timezone and does not mark an activity at its due instant', () => {
  assert.deepEqual(unansweredActivities(items, '2026-10-21T06:00:00.000Z', 'Asia/Kolkata'), [
    { id: 'earlier', title: 'Water', time: '09:00', state: 'unanswered' },
  ]);
});

test('care review does not infer unanswered activities when there are no scheduled items', () => {
  assert.deepEqual(unansweredActivities([], '2026-10-21T23:59:00.000Z', 'UTC'), []);
});

test('invalid instants, time zones, and activity times are ignored safely', () => {
  const malformed = [{ id: 'bad-time', time: '25:90', state: 'upcoming' }];
  assert.deepEqual(unansweredActivities(items, 'not-a-date', 'UTC'), []);
  assert.deepEqual(unansweredActivities(items, '2026-02-31T10:00:00Z', 'UTC'), []);
  assert.equal(isIsoUtcInstant('2026-02-31T10:00:00Z'), false);
  assert.equal(isIsoUtcInstant('2026-02-28T10:00:00.12Z'), true);
  assert.deepEqual(unansweredActivities(items, '2026-10-21T23:59:00.000Z', 'Not/AZone'), []);
  assert.deepEqual(unansweredActivities(malformed, '2026-10-21T23:59:00.000Z', 'UTC'), []);
});

test('spring daylight-saving gaps are not treated as elapsed schedule times', () => {
  const scheduledInGap = [{ id: 'gap', time: '02:30', state: 'upcoming' }];
  assert.deepEqual(unansweredActivities(scheduledInGap, '2026-03-08T07:00:00.000Z', 'America/New_York'), []);
});

test('fall daylight-saving repeats wait until the later occurrence has elapsed', () => {
  const repeatedTime = [{ id: 'fold', time: '01:30', state: 'upcoming' }];
  assert.deepEqual(unansweredActivities(repeatedTime, '2026-11-01T05:45:00.000Z', 'America/New_York'), []);
  assert.deepEqual(unansweredActivities(repeatedTime, '2026-11-01T06:31:00.000Z', 'America/New_York'), [
    { id: 'fold', time: '01:30', state: 'unanswered' },
  ]);
});
