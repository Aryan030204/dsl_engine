// Tenant-local calendar day, used as the key for the storm-protection daily quota and
// exception latches. A day key is YYYY-MM-DD in the run's timezone, so the quota resets
// at the tenant's local midnight (never a rolling 24h window, never blind UTC).

const formatterCache = new Map();

function getFormatter(timeZone) {
  const key = timeZone || 'UTC';
  if (!formatterCache.has(key)) {
    formatterCache.set(key, new Intl.DateTimeFormat('en-CA', {
      year: 'numeric', month: '2-digit', day: '2-digit', timeZone: key
    }));
  }
  return formatterCache.get(key);
}

function localDayKey(date, timeZone) {
  const value = date instanceof Date ? date : new Date(date);
  const parts = getFormatter(timeZone).formatToParts(value);
  const pick = (type) => parts.find((part) => part.type === type)?.value;
  return `${pick('year')}-${pick('month')}-${pick('day')}`;
}

module.exports = { localDayKey };
