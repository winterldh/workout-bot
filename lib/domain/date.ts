const WEEKDAY_INDEX: Record<string, number> = {
  Mon: 0,
  Tue: 1,
  Wed: 2,
  Thu: 3,
  Fri: 4,
  Sat: 5,
  Sun: 6,
};

export function formatDateKey(date: Date, timeZone: string) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = formatter.formatToParts(date);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;

  return `${year}-${month}-${day}`;
}

export function dateKeyToUtcDate(dateKey: string) {
  return new Date(`${dateKey}T00:00:00.000Z`);
}

export function normalizeRecordDate(date: Date, timeZone: string) {
  return dateKeyToUtcDate(formatDateKey(date, timeZone));
}

export function normalizeRecordDateToKst(date: Date) {
  return normalizeRecordDate(date, 'Asia/Seoul');
}

export function addUtcDays(date: Date, days: number) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

export function getWeekRange(referenceDate: Date, timeZone: string) {
  const dateKey = formatDateKey(referenceDate, timeZone);
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
  }).format(referenceDate);

  const startDate = addUtcDays(dateKeyToUtcDate(dateKey), -WEEKDAY_INDEX[weekday]);
  const endDate = addUtcDays(startDate, 6);

  return { startDate, endDate };
}

export function toSlackTimestampDate(timestamp?: string) {
  if (!timestamp) {
    return new Date();
  }

  const seconds = Number(timestamp.split('.')[0]);
  return Number.isFinite(seconds) ? new Date(seconds * 1000) : new Date();
}
