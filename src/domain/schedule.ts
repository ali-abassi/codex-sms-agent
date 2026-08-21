/** Pure scheduling math for routines. Times are local to the host. */

export const DAY_MS = 24 * 60 * 60_000;
export const ALL_DAYS = 0b1111111;
const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

export type Schedule = {
  intervalMs: number;
  /** Minutes after local midnight to run at; requires intervalMs to be a whole number of days. */
  atMinute?: number;
  /** Bit mask, bit 0 = Sunday. ALL_DAYS means every day. */
  daysMask: number;
};

export function parseDays(value: string): number {
  const text = value.trim().toLowerCase();
  if (text === "" || text === "all" || text === "daily" || text === "every") return ALL_DAYS;
  if (text === "weekdays") return 0b0111110;
  if (text === "weekends") return 0b1000001;
  let mask = 0;
  for (const part of text.split(",")) {
    const index = DAY_NAMES.findIndex((name) => part.trim().startsWith(name));
    if (index === -1) throw new Error(`Unknown day "${part.trim()}"; use mon,tue,... or weekdays/weekends`);
    mask |= 1 << index;
  }
  return mask;
}

export function formatDays(mask: number): string {
  if (mask === ALL_DAYS) return "every day";
  if (mask === 0b0111110) return "weekdays";
  if (mask === 0b1000001) return "weekends";
  return DAY_NAMES.filter((_, index) => mask & (1 << index)).join(",");
}

export function parseClockTime(value: string): number {
  const match = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) throw new Error("Time must look like 08:00 or 17:30 (24-hour)");
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) throw new Error("Time must be between 00:00 and 23:59");
  return hours * 60 + minutes;
}

export function formatClockTime(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

export function validateSchedule(schedule: Schedule): Schedule {
  if (!Number.isSafeInteger(schedule.intervalMs) || schedule.intervalMs < 60_000) {
    throw new RangeError("intervalMs must be at least one minute");
  }
  if (!Number.isInteger(schedule.daysMask) || schedule.daysMask < 1 || schedule.daysMask > ALL_DAYS) {
    throw new RangeError("daysMask must select at least one day");
  }
  if (schedule.atMinute !== undefined) {
    if (!Number.isInteger(schedule.atMinute) || schedule.atMinute < 0 || schedule.atMinute >= 24 * 60) {
      throw new RangeError("atMinute must be within a day");
    }
    if (schedule.intervalMs % DAY_MS !== 0) {
      throw new RangeError("A clock time requires a whole-day interval (1d, 2d, 1w, ...)");
    }
  }
  if (schedule.daysMask !== ALL_DAYS && schedule.intervalMs % DAY_MS !== 0) {
    throw new RangeError("Day-of-week filters require a whole-day interval");
  }
  return schedule;
}

function localMidnight(epochMs: number): Date {
  const date = new Date(epochMs);
  date.setHours(0, 0, 0, 0);
  return date;
}

/** The first run strictly after `after`, honoring the clock time and day filter. */
export function nextRunAfter(after: number, schedule: Schedule, previous?: number): number {
  const { intervalMs, atMinute, daysMask } = validateSchedule(schedule);
  if (atMinute === undefined && daysMask === ALL_DAYS) {
    let next = previous === undefined ? after + intervalMs : previous;
    while (next <= after) next += intervalMs;
    return next;
  }
  const stepDays = Math.max(1, Math.round(intervalMs / DAY_MS));
  // Walk day by day from the anchor so DST shifts cannot drift the clock time.
  const anchor = localMidnight(previous ?? after);
  for (let dayOffset = 0; dayOffset < 366 * 2; dayOffset += 1) {
    const candidateDay = new Date(anchor);
    candidateDay.setDate(anchor.getDate() + dayOffset);
    const candidate = new Date(candidateDay);
    candidate.setHours(0, atMinute ?? 0, 0, 0);
    const time = atMinute === undefined && previous !== undefined
      ? previous + dayOffset * DAY_MS
      : candidate.getTime();
    if (time <= after) continue;
    if (!(daysMask & (1 << candidate.getDay()))) continue;
    if (previous !== undefined && stepDays > 1) {
      const daysSince = Math.round((localMidnight(time).getTime() - localMidnight(previous).getTime()) / DAY_MS);
      if (daysSince % stepDays !== 0) continue;
    }
    return time;
  }
  throw new RangeError("No run time found within two years");
}

export function describeSchedule(schedule: Schedule): string {
  const days = schedule.intervalMs / DAY_MS;
  const every = schedule.intervalMs % DAY_MS === 0
    ? days === 1 ? "daily" : days === 7 ? "weekly" : `every ${days} days`
    : schedule.intervalMs % 3_600_000 === 0
      ? `every ${schedule.intervalMs / 3_600_000}h`
      : `every ${Math.round(schedule.intervalMs / 60_000)}m`;
  const at = schedule.atMinute === undefined ? "" : ` at ${formatClockTime(schedule.atMinute)}`;
  const on = schedule.daysMask === ALL_DAYS ? "" : ` on ${formatDays(schedule.daysMask)}`;
  return `${every}${at}${on}`;
}
