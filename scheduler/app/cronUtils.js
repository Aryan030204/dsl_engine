// Building an Intl.DateTimeFormat is expensive and the cron search below formats a timestamp per
// candidate minute, so one formatter per time zone is built once and reused.
const formatterCache = new Map();

function getFormatter(timeZone) {
  const key = timeZone || 'UTC';
  if (!formatterCache.has(key)) {
    formatterCache.set(key, new Intl.DateTimeFormat('en-US', {
      timeZone: key,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short'
    }));
  }
  return formatterCache.get(key);
}

function getTimeZoneParts(date, timeZone = 'UTC') {
  const formatter = getFormatter(timeZone);
  const parts = formatter.formatToParts(date);
  const map = {};
  parts.forEach((part) => {
    if (part.type !== 'literal') map[part.type] = part.value;
  });

  const weekdayMap = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6
  };

  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second),
    weekday: weekdayMap[map.weekday]
  };
}

function localDateTimeToUtc({
  year,
  month,
  day,
  hour = 0,
  minute = 0,
  second = 0
}, timeZone = 'UTC') {
  let guess = new Date(Date.UTC(year, month - 1, day, hour, minute, second));

  for (let i = 0; i < 4; i += 1) {
    const parts = getTimeZoneParts(guess, timeZone);
    const desiredUtcMs = Date.UTC(year, month - 1, day, hour, minute, second);
    const actualUtcMs = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second
    );
    const diffMs = desiredUtcMs - actualUtcMs;
    if (diffMs === 0) return guess;
    guess = new Date(guess.getTime() + diffMs);
  }

  return guess;
}

// One cron field -> the set of values it allows. Strict: anything that is not a valid value, range
// or step throws, instead of being silently dropped (a typo used to leave an empty set that never
// matched, so the schedule just never ran).
function parsePart(part, min, max, label = 'field') {
  const values = new Set();
  const text = String(part).trim();
  const fail = () => new Error(`invalid cron ${label} "${text}"`);
  if (!text) throw fail();

  for (const chunkRaw of text.split(',')) {
    const chunk = chunkRaw.trim();
    if (!chunk) throw fail();

    const [rangePart, stepPart, extra] = chunk.split('/');
    if (extra !== undefined) throw fail();
    let step = 1;
    if (stepPart !== undefined) {
      step = Number(stepPart);
      if (!/^\d+$/.test(stepPart) || !Number.isInteger(step) || step <= 0) throw fail();
    }

    let start;
    let end;
    if (rangePart === '*') {
      start = min;
      end = max;
    } else if (/^\d+-\d+$/.test(rangePart)) {
      [start, end] = rangePart.split('-').map(Number);
    } else if (/^\d+$/.test(rangePart)) {
      start = Number(rangePart);
      end = stepPart !== undefined ? max : start; // "5/15" means 5 through the end, every 15
    } else {
      throw fail();
    }
    if (start < min || end > max || start > end) throw fail();

    for (let i = start; i <= end; i += step) values.add(i);
  }

  if (!values.size) throw fail();
  return values;
}

function parseCronExpr(expr) {
  const parts = String(expr || '').trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error('cron expression must have 5 parts (minute hour day month weekday)');
  }

  // Weekday accepts 0-7 (both 0 and 7 are Sunday).
  const weekday = parsePart(parts[4], 0, 7, 'weekday');
  if (weekday.delete(7)) weekday.add(0);

  return {
    minute: parsePart(parts[0], 0, 59, 'minute'),
    hour: parsePart(parts[1], 0, 23, 'hour'),
    day: parsePart(parts[2], 1, 31, 'day-of-month'),
    month: parsePart(parts[3], 1, 12, 'month'),
    weekday,
    // Standard cron: when BOTH day-of-month and weekday are restricted, a date matches if EITHER does.
    dayIsWildcard: parts[2].trim().startsWith('*'),
    weekdayIsWildcard: parts[4].trim().startsWith('*')
  };
}

function validateCronExpr(expr) {
  try {
    parseCronExpr(expr);
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function isTopOfHourCronExpr(expr) {
  const cron = parseCronExpr(expr);
  return cron.minute.size === 1 && cron.minute.has(0);
}

function dayMatches(cron, parts) {
  const dayOk = cron.day.has(parts.day);
  const weekdayOk = cron.weekday.has(parts.weekday);
  if (!cron.dayIsWildcard && !cron.weekdayIsWildcard) return dayOk || weekdayOk;
  return dayOk && weekdayOk;
}

function matchesCronDate(cron, date, timeZone = 'UTC') {
  const parts = getTimeZoneParts(date, timeZone);
  return cron.minute.has(parts.minute)
    && cron.hour.has(parts.hour)
    && cron.month.has(parts.month)
    && dayMatches(cron, parts);
}

const MINUTE_MS = 60 * 1000;
const MAX_SEARCH_STEPS = 600000;

// First matching minute strictly after `after` (and not after `until`, when given), or null. Rather
// than testing every minute, it jumps past whole days / hours that cannot match, so even a yearly
// expression is a few hundred steps. Time only ever moves forward, so it always terminates.
function nextMatchAfter(cron, after, timeZone, until = null) {
  const cursor = new Date(Math.floor(new Date(after).getTime() / MINUTE_MS) * MINUTE_MS + MINUTE_MS);
  const untilMs = until ? new Date(until).getTime() : Infinity;

  for (let steps = 0; steps < MAX_SEARCH_STEPS && cursor.getTime() <= untilMs; steps += 1) {
    const parts = getTimeZoneParts(cursor, timeZone);

    if (!cron.month.has(parts.month) || !dayMatches(cron, parts)) {
      // not a matching day: skip to the next local midnight
      cursor.setTime(cursor.getTime() + ((24 * 60) - (parts.hour * 60 + parts.minute)) * MINUTE_MS);
    } else if (!cron.hour.has(parts.hour)) {
      // not a matching hour: skip to the top of the next hour
      cursor.setTime(cursor.getTime() + (60 - parts.minute) * MINUTE_MS);
    } else if (cron.minute.has(parts.minute)) {
      return new Date(cursor);
    } else {
      cursor.setTime(cursor.getTime() + MINUTE_MS);
    }
  }
  return null;
}

function getNextRunAt(expr, fromDate, timeZone = 'UTC') {
  const cron = parseCronExpr(expr);
  const next = nextMatchAfter(cron, fromDate, timeZone);
  if (!next) throw new Error('unable to compute next run for cron expression');
  return next;
}

// Scheduled times in (startExclusive, endInclusive], oldest first, at most maxRuns.
function listMissedRuns(expr, startExclusive, endInclusive, maxRuns = 500, timeZone = 'UTC') {
  const cron = parseCronExpr(expr);
  const missed = [];
  let cursor = new Date(startExclusive);

  while (missed.length < maxRuns) {
    const next = nextMatchAfter(cron, cursor, timeZone, endInclusive);
    if (!next) break;
    missed.push(next);
    cursor = next;
  }

  return missed;
}

module.exports = {
  getNextRunAt,
  listMissedRuns,
  parseCronExpr,
  validateCronExpr,
  isTopOfHourCronExpr,
  getTimeZoneParts,
  localDateTimeToUtc
};
