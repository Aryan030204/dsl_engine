// Plain-English descriptions for schedules, so people don't have to read cron.

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const pad = (value) => String(value).padStart(2, '0');
const isInt = (text) => /^\d+$/.test(text);

function listOf(field, min, max) {
  if (!/^\d+(,\d+)*$/.test(field)) return null;
  const values = field.split(',').map(Number);
  return values.every((value) => value >= min && value <= max) ? values : null;
}

function joinList(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

// Returns a sentence such as "Every day at 11:03, 14:03 and 17:03", or null when the
// expression isn't one of the common shapes (the caller then shows the raw cron).
export function describeCron(expression) {
  const parts = String(expression || '').trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  if (dayOfMonth !== '*' || month !== '*') return null;

  const step = /^\*\/(\d+)$/.exec(minute);
  if (step && hour === '*' && dayOfWeek === '*') {
    const n = Number(step[1]);
    return n === 1 ? 'Every minute' : `Every ${n} minutes`;
  }

  if (isInt(minute) && hour === '*' && dayOfWeek === '*') {
    return Number(minute) === 0 ? 'Every hour, on the hour' : `Every hour at ${pad(minute)} minutes past`;
  }

  const minutes = listOf(minute, 0, 59);
  const hours = listOf(hour, 0, 23);
  if (!minutes || minutes.length !== 1 || !hours) return null;
  const times = joinList(hours.map((h) => `${pad(h)}:${pad(minutes[0])}`));

  if (dayOfWeek === '*') return `Every day at ${times}`;
  if (dayOfWeek === '1-5') return `Weekdays at ${times}`;
  const days = listOf(dayOfWeek, 0, 7);
  if (days) return `Every ${joinList(days.map((d) => DAY_NAMES[d % 7]))} at ${times}`;
  return null;
}
