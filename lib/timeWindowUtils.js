const SQL_DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/;
const ISO_TZ_RE = /(Z|[+-]\d{2}:\d{2})$/i;
const BUSINESS_TIME_ZONE = 'Asia/Kolkata';

function isSupportedTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || !timeZone.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function parseSqlDateTime(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace('T', ' ').replace('Z', '');
  const match = normalized.match(SQL_DATETIME_RE);
  if (!match) return null;

  const [
    ,
    year,
    month,
    day,
    hour,
    minute,
    second = '00'
  ] = match;

  return {
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: Number(hour),
    minute: Number(minute),
    second: Number(second),
    normalized: `${year}-${month}-${day} ${hour}:${minute}:${second}`
  };
}

function toUtcMs(parts) {
  if (!parts) return NaN;
  return Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );
}

function isHourAligned(value) {
  const parts = typeof value === 'string' ? parseSqlDateTime(value) : value;
  return Boolean(parts) && parts.minute === 0 && parts.second === 0;
}

function isFullDayAlignedWindow(start, end) {
  const startParts = typeof start === 'string' ? parseSqlDateTime(start) : start;
  const endParts = typeof end === 'string' ? parseSqlDateTime(end) : end;
  if (!startParts || !endParts) return false;
  if (!isHourAligned(startParts) || !isHourAligned(endParts)) return false;
  if (startParts.hour !== 0 || endParts.hour !== 0) return false;

  const durationMs = toUtcMs(endParts) - toUtcMs(startParts);
  if (durationMs <= 0) return false;

  const hourMs = 60 * 60 * 1000;
  const durationHours = durationMs / hourMs;
  return Number.isInteger(durationHours) && durationHours % 24 === 0;
}

function isPartialDayWindow(start, end) {
  const startParts = typeof start === 'string' ? parseSqlDateTime(start) : start;
  const endParts = typeof end === 'string' ? parseSqlDateTime(end) : end;
  if (!startParts || !endParts) return false;
  if (!isHourAligned(startParts) || !isHourAligned(endParts)) return false;
  return !isFullDayAlignedWindow(startParts, endParts);
}

function hasPositiveDuration(start, end) {
  const startParts = typeof start === 'string' ? parseSqlDateTime(start) : start;
  const endParts = typeof end === 'string' ? parseSqlDateTime(end) : end;
  if (!startParts || !endParts) return false;
  return toUtcMs(endParts) > toUtcMs(startParts);
}

function listHourlyProductUnsupportedFilters(filters = []) {
  return (Array.isArray(filters) ? filters : [])
    .filter((filter) => filter?.dimension && filter.dimension !== 'product_id')
    .map((filter) => filter.dimension);
}

function listHourlyLandingPagePathUnsupportedFilters(filters = []) {
  return (Array.isArray(filters) ? filters : [])
    .filter((filter) => filter?.dimension && filter.dimension !== 'product_id')
    .map((filter) => filter.dimension);
}

function formatInTimeZone(date, timeZone = BUSINESS_TIME_ZONE) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });

  const parts = formatter.formatToParts(date);
  const map = {};
  parts.forEach((part) => {
    if (part.type !== 'literal') {
      map[part.type] = part.value;
    }
  });

  return `${map.year}-${map.month}-${map.day} ${map.hour}:${map.minute}:${map.second}`;
}

function normalizeQueryDateTime(value, timeZone = BUSINESS_TIME_ZONE) {
  if (!value || typeof value !== 'string') return value;

  const trimmed = value.trim();
  const parsedSql = parseSqlDateTime(trimmed);

  if (!ISO_TZ_RE.test(trimmed)) {
    return parsedSql ? parsedSql.normalized : trimmed.replace('T', ' ');
  }

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    return parsedSql ? parsedSql.normalized : trimmed.replace('T', ' ').replace('Z', '');
  }

  return formatInTimeZone(parsed, timeZone);
}

function floorSqlDateTimeToHour(value, timeZone = BUSINESS_TIME_ZONE) {
  if (typeof value !== 'string') return value;

  const normalized = normalizeQueryDateTime(value, timeZone);
  const match = String(normalized).trim().match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}):\d{2}(?::\d{2})?$/);
  if (!match) return value;

  return `${match[1]} ${match[2]}:00:00`;
}

function normalizeWindowForQuery(range, timeZone = BUSINESS_TIME_ZONE) {
  if (!range || typeof range !== 'object') return range;

  return {
    ...range,
    start: normalizeQueryDateTime(range.start, timeZone),
    end: normalizeQueryDateTime(range.end, timeZone)
  };
}

function normalizeRerunWindow(range, timeZone = BUSINESS_TIME_ZONE) {
  if (!range || typeof range !== 'object') return range;

  return {
    ...range,
    start: floorSqlDateTimeToHour(range.start, timeZone),
    end: floorSqlDateTimeToHour(range.end, timeZone)
  };
}

function normalizeRerunContext(context, timeZone = BUSINESS_TIME_ZONE) {
  if (!context || typeof context !== 'object') return context;

  // Tenant branding and currency are injected into a run immediately before
  // execution. Do not carry that injected snapshot into a rerun, otherwise later
  // tenant edits are ignored because the runner sees them already present.
  const {
    emailBranding: _previousEmailBranding,
    currency: _previousCurrency,
    ...rerunMeta
  } = context.meta || {};

  return {
    meta: {
      ...rerunMeta,
      timezone: context.meta?.timezone || timeZone,
      window: normalizeRerunWindow(context.meta?.window, timeZone),
      baselineWindow: normalizeRerunWindow(context.meta?.baselineWindow, timeZone)
    },
    // A completed run contains derived values from its previous execution.
    // Preserve only user-supplied filters when rerunning; analytical state must
    // be recomputed from scratch for the selected workflow version.
    filters: Array.isArray(context.filters) ? context.filters : [],
    metrics: {},
    breakdowns: {},
    rootCausePath: [],
    scratch: {},
    executionTrace: []
  };
}

module.exports = {
  BUSINESS_TIME_ZONE,
  isSupportedTimeZone,
  parseSqlDateTime,
  isHourAligned,
  isFullDayAlignedWindow,
  isPartialDayWindow,
  hasPositiveDuration,
  listHourlyProductUnsupportedFilters,
  listHourlyLandingPagePathUnsupportedFilters,
  normalizeQueryDateTime,
  floorSqlDateTimeToHour,
  normalizeWindowForQuery,
  normalizeRerunWindow,
  normalizeRerunContext,
};
