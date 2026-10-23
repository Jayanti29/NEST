export type ActivityReviewItem = {
  state: string;
  time: string;
  [key: string]: unknown;
};

export function isIsoUtcInstant(value: string): boolean {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)) return false;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return false;
  const [base, fraction] = value.slice(0, -1).split('.');
  const canonical = new Date(timestamp).toISOString();
  return canonical.slice(0, 19) === base && canonical.slice(20, 23) === (fraction || '000').padEnd(3, '0');
}

type LocalParts = { year: number; month: number; day: number; hour: number; minute: number };

function localPartsAt(instant: number, formatter: Intl.DateTimeFormat): LocalParts {
  const parts = Object.fromEntries(formatter.formatToParts(new Date(instant)).map(part => [part.type, part.value]));
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour), minute: Number(parts.minute),
  };
}

function sameLocalMinute(actual: LocalParts, expected: LocalParts): boolean {
  return actual.year === expected.year && actual.month === expected.month && actual.day === expected.day
    && actual.hour === expected.hour && actual.minute === expected.minute;
}

/**
 * Marks scheduled activities unanswered only after their local wall-clock time has elapsed.
 * A wall time skipped by a daylight-saving transition has no occurrence and is not marked.
 * During a repeated hour, the later matching instant is used to avoid marking too early.
 */
export function unansweredActivities<T extends ActivityReviewItem>(items: T[], localNow: string, timeZone: string): Array<T & { state: 'unanswered' }> {
  if (!isIsoUtcInstant(localNow)) return [];
  const now = Date.parse(localNow);
  if (!Number.isFinite(now)) return [];

  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone, calendar: 'gregory', numberingSystem: 'latn', hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    });
    formatter.format(new Date(now));
  } catch {
    return [];
  }

  const today = localPartsAt(now, formatter);
  const scheduleEpoch = Date.UTC(today.year, today.month - 1, today.day, 0, 0);
  const offsets = new Set<number>();
  for (let hour = -48; hour <= 48; hour += 6) {
    const sample = scheduleEpoch + hour * 60 * 60 * 1000;
    const atZone = localPartsAt(sample, formatter);
    const representedAsUtc = Date.UTC(atZone.year, atZone.month - 1, atZone.day, atZone.hour, atZone.minute);
    offsets.add(representedAsUtc - Math.floor(sample / 60000) * 60000);
  }

  const occurrenceByTime = new Map<string, number | null>();
  const occurrence = (time: string): number | null => {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return null;
    if (occurrenceByTime.has(time)) return occurrenceByTime.get(time)!;
    const [, hour, minute] = time.match(/^(\d\d):(\d\d)$/)!;
    const expected: LocalParts = { ...today, hour: Number(hour), minute: Number(minute) };
    const naive = Date.UTC(today.year, today.month - 1, today.day, expected.hour, expected.minute);
    const matches: number[] = [];
    for (const offset of offsets) {
      const candidate = naive - offset;
      if (sameLocalMinute(localPartsAt(candidate, formatter), expected)) matches.push(candidate);
    }
    const result = matches.length ? Math.max(...matches) : null;
    occurrenceByTime.set(time, result);
    return result;
  };

  return items
    .filter(item => item.state === 'upcoming')
    .filter(item => {
      const scheduledAt = occurrence(item.time);
      return scheduledAt !== null && now > scheduledAt;
    })
    .map(item => ({ ...item, state: 'unanswered' }));
}
