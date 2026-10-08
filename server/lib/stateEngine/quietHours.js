// Quiet hours are evaluated at minute resolution in the run's timezone, with both
// boundaries inclusive: for 23:00-07:00, 07:00 (through 07:00:59) is quiet and 07:01
// is not. A window whose start is after its end wraps midnight.

const MINUTE_MS = 60 * 1000;
// Guard for pathological configs (a quiet window covering all but a minute or two
// of the day, with a long cooldown), where walking to the cap could take millions
// of steps. Past this, the cooldown is treated as having run its course.
const MAX_WALK_MINUTES = 200000;

const formatterCache = new Map();

function getFormatter(timeZone) {
  const key = timeZone || 'UTC';
  if (!formatterCache.has(key)) {
    formatterCache.set(key, new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: key
    }));
  }
  return formatterCache.get(key);
}

function parseHHMM(value) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value || ''));
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function minuteOfDay(date, timeZone) {
  const parts = getFormatter(timeZone).formatToParts(date);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value);
  return hour * 60 + minute;
}

function resolveWindow(quietHours) {
  if (!quietHours?.enabled) return null;
  const start = parseHHMM(quietHours.start);
  const end = parseHHMM(quietHours.end);
  if (start == null || end == null) return null;
  return { start, end };
}

function isQuietMinute(date, quietHours, timeZone) {
  const window = resolveWindow(quietHours);
  if (!window) return false;
  const minute = minuteOfDay(date instanceof Date ? date : new Date(date), timeZone);
  if (window.start <= window.end) return minute >= window.start && minute <= window.end;
  return minute >= window.start || minute <= window.end;
}

// Cooldown clock that pauses inside quiet hours (spec §19): wall time from
// startedAt to now, minus every minute spent inside the quiet window. Walks minute
// boundaries so DST shifts and wrap-around come out right, and stops early once
// capMs of active time has accumulated -- callers only need to know whether the
// cooldown has run out, not the exact figure past that point.
function effectiveElapsedMs(startedAt, now, quietHours, timeZone, capMs = null) {
  const startMs = new Date(startedAt).getTime();
  const nowMs = new Date(now).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(nowMs) || nowMs <= startMs) return 0;
  if (!resolveWindow(quietHours)) return nowMs - startMs;

  let cursor = startMs;
  let active = 0;
  let steps = 0;
  while (cursor < nowMs && (capMs == null || active < capMs)) {
    if (steps++ > MAX_WALK_MINUTES) return capMs ?? active;
    const next = Math.min(Math.floor(cursor / MINUTE_MS) * MINUTE_MS + MINUTE_MS, nowMs);
    if (!isQuietMinute(new Date(cursor), quietHours, timeZone)) {
      active += next - cursor;
    }
    cursor = next;
  }
  return active;
}

module.exports = {
  parseHHMM,
  isQuietMinute,
  effectiveElapsedMs
};
