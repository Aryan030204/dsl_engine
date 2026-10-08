const test = require('node:test');
const assert = require('node:assert/strict');

const { isQuietMinute, effectiveElapsedMs } = require('../server/lib/stateEngine/quietHours');

const MIN = 60 * 1000;
const overnight = { enabled: true, start: '23:00', end: '07:00' };

test('a window that wraps midnight is quiet on both sides of it', () => {
  assert.equal(isQuietMinute(new Date('2026-01-01T23:00:00Z'), overnight, 'UTC'), true);
  assert.equal(isQuietMinute(new Date('2026-01-02T02:00:00Z'), overnight, 'UTC'), true);
  assert.equal(isQuietMinute(new Date('2026-01-01T22:59:59Z'), overnight, 'UTC'), false);
  assert.equal(isQuietMinute(new Date('2026-01-01T12:00:00Z'), overnight, 'UTC'), false);
});

test('both boundaries are inclusive at minute resolution', () => {
  assert.equal(isQuietMinute(new Date('2026-01-02T07:00:00Z'), overnight, 'UTC'), true);
  assert.equal(isQuietMinute(new Date('2026-01-02T07:00:59Z'), overnight, 'UTC'), true);
  assert.equal(isQuietMinute(new Date('2026-01-02T07:01:00Z'), overnight, 'UTC'), false);
});

test('a same-day window works too', () => {
  const lunch = { enabled: true, start: '12:00', end: '13:00' };
  assert.equal(isQuietMinute(new Date('2026-01-01T12:30:00Z'), lunch, 'UTC'), true);
  assert.equal(isQuietMinute(new Date('2026-01-01T13:01:00Z'), lunch, 'UTC'), false);
  assert.equal(isQuietMinute(new Date('2026-01-01T11:59:00Z'), lunch, 'UTC'), false);
});

test('disabled or malformed quiet hours are never quiet', () => {
  assert.equal(isQuietMinute(new Date('2026-01-02T02:00:00Z'), { ...overnight, enabled: false }, 'UTC'), false);
  assert.equal(isQuietMinute(new Date('2026-01-02T02:00:00Z'), { enabled: true, start: '25:00', end: '07:00' }, 'UTC'), false);
  assert.equal(isQuietMinute(new Date('2026-01-02T02:00:00Z'), null, 'UTC'), false);
});

test('quiet hours are evaluated in the run timezone', () => {
  // Asia/Kolkata is UTC+05:30.
  assert.equal(isQuietMinute(new Date('2026-01-01T18:00:00Z'), overnight, 'Asia/Kolkata'), true); // 23:30 IST
  assert.equal(isQuietMinute(new Date('2026-01-02T01:30:00Z'), overnight, 'Asia/Kolkata'), true); // 07:00 IST
  assert.equal(isQuietMinute(new Date('2026-01-02T01:31:00Z'), overnight, 'Asia/Kolkata'), false); // 07:01 IST
  assert.equal(isQuietMinute(new Date('2026-01-02T01:31:00Z'), overnight, 'UTC'), true); // 01:31 UTC
});

test('spec §19: a cooldown started at 22:50 has used 10 minutes when quiet hours begin', () => {
  const startedAt = '2026-01-01T22:50:00Z';
  assert.equal(effectiveElapsedMs(startedAt, '2026-01-01T23:30:00Z', overnight, 'UTC'), 10 * MIN);
  // Still 10 through the whole night, including the inclusive 07:00 minute.
  assert.equal(effectiveElapsedMs(startedAt, '2026-01-02T07:01:00Z', overnight, 'UTC'), 10 * MIN);
  // The remaining 50 minutes resume at 07:01, so the cooldown expires at 07:51.
  assert.equal(effectiveElapsedMs(startedAt, '2026-01-02T07:50:00Z', overnight, 'UTC'), 59 * MIN);
  assert.equal(effectiveElapsedMs(startedAt, '2026-01-02T07:51:00Z', overnight, 'UTC'), 60 * MIN);
});

test('without quiet hours, elapsed time is plain wall time', () => {
  assert.equal(effectiveElapsedMs('2026-01-01T10:00:00Z', '2026-01-01T11:30:00Z', null, 'UTC'), 90 * MIN);
});

test('the walk stops once the cap is reached', () => {
  const elapsed = effectiveElapsedMs('2026-01-01T08:00:00Z', '2026-03-01T08:00:00Z', overnight, 'UTC', 30 * MIN);
  assert.equal(elapsed, 30 * MIN);
});

test('DST: minutes skipped by spring-forward are not counted as quiet', () => {
  // America/New_York springs forward 2026-03-08 at 02:00 -> 03:00. Quiet 01:00-03:00
  // local covers 01:00-01:59 EST (06:00-07:00Z) plus the inclusive 03:00 EDT minute
  // (07:00Z), i.e. 61 quiet minutes in 3 hours of wall time.
  const window = { enabled: true, start: '01:00', end: '03:00' };
  const elapsed = effectiveElapsedMs('2026-03-08T05:00:00Z', '2026-03-08T08:00:00Z', window, 'America/New_York');
  assert.equal(elapsed, 119 * MIN);
});
