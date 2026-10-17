const DAY_MS = 86_400_000;
// Bilibili displays wall-clock times in China Standard Time, independent of the visitor's timezone.
const CST_OFFSET_MS = 8 * 3_600_000;
const relativeUnits: Record<string, number> = {秒: 1000, 分钟: 60_000, 小时: 3_600_000, 天: DAY_MS};

const chinaTime = (year: number, month: number, day: number, hour = 0, minute = 0) =>
  Date.UTC(year, month - 1, day, hour, minute) - CST_OFFSET_MS;
const validDate = (month: number, day: number) => month >= 1 && month <= 12 && day >= 1 && day <= 31;

/**
 * Parses Bilibili's displayed publish time: relative ("3天前", "昨天"), full
 * ("2025-03-12", "2025年3月12日") and current-year ("10-14", "9月29日") forms.
 * Unrecognized text returns undefined so callers can fail closed.
 */
export function parseBilibiliDate(value: string | undefined, now = Date.now()): string | undefined {
  const text = value?.replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  if (/刚刚/.test(text)) return new Date(now).toISOString();
  const relative = text.match(/(\d+)\s*(秒|分钟|小时|天)前/);
  if (relative) return new Date(now - Number(relative[1]) * relativeUnits[relative[2]]).toISOString();
  const today = new Date(now + CST_OFFSET_MS);
  const [year, month, day] = [today.getUTCFullYear(), today.getUTCMonth() + 1, today.getUTCDate()];
  const named = text.match(/(昨天|前天)(?:\s*(\d{1,2}):(\d{2}))?/);
  if (named) {
    return new Date(chinaTime(year, month, day - (named[1] === '昨天' ? 1 : 2),
      Number(named[2] || 0), Number(named[3] || 0))).toISOString();
  }
  const full = text.match(/(20\d{2})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?(?:\s*(\d{1,2}):(\d{2}))?/);
  if (full) {
    if (!validDate(Number(full[2]), Number(full[3]))) return undefined;
    return new Date(chinaTime(Number(full[1]), Number(full[2]), Number(full[3]),
      Number(full[4] || 0), Number(full[5] || 0))).toISOString();
  }
  const short = text.match(/(?<![\d:])(\d{1,2})\s*[-/.月]\s*(\d{1,2})(?![\d:])\s*日?(?:\s*(\d{1,2}):(\d{2}))?/);
  if (!short || !validDate(Number(short[1]), Number(short[2]))) return undefined;
  const time = [Number(short[1]), Number(short[2]), Number(short[3] || 0), Number(short[4] || 0)] as const;
  let parsed = chinaTime(year, ...time);
  // A month/day without a year is the most recent such date, never one in the future.
  if (parsed > now + DAY_MS) parsed = chinaTime(year - 1, ...time);
  return new Date(parsed).toISOString();
}

/**
 * A source belongs to the requested window only with a known publish time;
 * unknown dates are rejected. Day-precision dates get one day of slack because
 * they parse to midnight.
 */
export function inContentWindow(publishedAt: string | undefined, contentWindowDays: number,
  options: {now?: number; dayPrecision?: boolean} = {}): boolean {
  const time = publishedAt ? Date.parse(publishedAt) : Number.NaN;
  if (!Number.isFinite(time)) return false;
  const cutoff = (options.now ?? Date.now()) - contentWindowDays * DAY_MS;
  return time + (options.dayPrecision ? DAY_MS : 0) >= cutoff;
}
