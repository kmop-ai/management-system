// Date helpers. Dates are 'YYYY-MM-DD' strings everywhere (no time zone
// ambiguity for due dates); timestamps are ISO-8601 UTC.

export const toDate = (s) => new Date(s + 'T00:00:00Z');
export const fmt = (d) => d.toISOString().slice(0, 10);
export const addDays = (s, n) => { const d = toDate(s); d.setUTCDate(d.getUTCDate() + n); return fmt(d); };
export const daysBetween = (a, b) => Math.round((toDate(b) - toDate(a)) / 86400000);
export const isoWeekday = (s) => { const w = toDate(s).getUTCDay(); return w === 0 ? 7 : w; };
export const mondayOf = (s) => addDays(s, 1 - isoWeekday(s));

export function addMonths(s, n, monthday = null) {
  const d = toDate(s);
  const day = monthday ?? d.getUTCDate();
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(day === -1 ? last : Math.min(day, last));
  return fmt(target);
}

// Project month: M1 is the calendar month containing the project start.
// EU work plans are written in M-numbers; the UI shows both.
export function projectMonth(start, date) {
  if (!start || !date) return null;
  const a = toDate(start), b = toDate(date);
  return (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth()) + 1;
}

// Local date for a time zone, for "due today" and digest hours.
export function localParts(tz, at = new Date()) {
  try {
    const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'Europe/Athens', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23', weekday: 'short' });
    const p = Object.fromEntries(f.formatToParts(at).map(x => [x.type, x.value]));
    return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), weekday: p.weekday };
  } catch {
    return { date: at.toISOString().slice(0, 10), hour: at.getUTCHours(), weekday: '' };
  }
}

// Next occurrence date for a recurrence rule, strictly after `from`.
export function nextOccurrence(rule, from) {
  const n = Math.max(1, rule.interval_n || 1);
  if (rule.freq === 'daily') return addDays(from, n);
  if (rule.freq === 'weekly') {
    const days = (rule.by_weekday || String(isoWeekday(from))).split('').map(Number).sort();
    // next listed weekday in the same week, else first listed weekday n weeks on
    const wd = isoWeekday(from);
    const later = days.find(d => d > wd);
    if (later) return addDays(from, later - wd);
    return addDays(mondayOf(from), 7 * n + days[0] - 1);
  }
  if (rule.freq === 'monthly') return addMonths(from, n, rule.by_monthday ?? null);
  if (rule.freq === 'yearly') return addMonths(from, 12 * n);
  throw new Error('unknown freq ' + rule.freq);
}
