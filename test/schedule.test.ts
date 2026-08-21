import { describe, expect, it } from "vitest";
import {
  ALL_DAYS,
  DAY_MS,
  describeSchedule,
  nextRunAfter,
  parseClockTime,
  parseDays,
  validateSchedule,
} from "../src/domain/schedule.js";

function local(year: number, month: number, day: number, hour = 0, minute = 0): number {
  return new Date(year, month - 1, day, hour, minute).getTime();
}

describe("routine schedules", () => {
  it("parses days and clock times", () => {
    expect(parseDays("weekdays")).toBe(0b0111110);
    expect(parseDays("sat,sun")).toBe(0b1000001);
    expect(parseDays("Mon, Wednesday")).toBe(0b0001010);
    expect(() => parseDays("funday")).toThrow(/Unknown day/);
    expect(parseClockTime("08:00")).toBe(480);
    expect(parseClockTime("23:59")).toBe(1439);
    expect(() => parseClockTime("24:00")).toThrow();
    expect(() => parseClockTime("8am")).toThrow();
  });

  it("requires whole-day intervals for clock times and day filters", () => {
    expect(() => validateSchedule({ intervalMs: 3_600_000, atMinute: 480, daysMask: ALL_DAYS })).toThrow(/whole-day/);
    expect(() => validateSchedule({ intervalMs: 3_600_000, daysMask: 0b0111110 })).toThrow(/whole-day/);
    expect(validateSchedule({ intervalMs: DAY_MS, atMinute: 480, daysMask: 0b0111110 })).toBeTruthy();
  });

  it("keeps plain intervals anchored to the previous run", () => {
    const schedule = { intervalMs: 60_000, daysMask: ALL_DAYS };
    expect(nextRunAfter(1_000, schedule)).toBe(61_000);
    expect(nextRunAfter(500_000, schedule, 61_000)).toBe(541_000);
  });

  it("runs at the clock time on allowed days, skipping weekends and stepping multi-day intervals", () => {
    const friday = local(2026, 8, 21, 9, 30); // 2026-08-21 is a Friday
    const weekdaysAt8 = { intervalMs: DAY_MS, atMinute: 480, daysMask: parseDays("weekdays") };
    expect(new Date(nextRunAfter(friday, weekdaysAt8))).toEqual(new Date(local(2026, 8, 24, 8, 0)));
    expect(new Date(nextRunAfter(local(2026, 8, 20, 7, 0), weekdaysAt8))).toEqual(new Date(local(2026, 8, 20, 8, 0)));

    const everyOtherDay = { intervalMs: 2 * DAY_MS, atMinute: 1080, daysMask: ALL_DAYS };
    const first = nextRunAfter(friday, everyOtherDay);
    expect(new Date(first)).toEqual(new Date(local(2026, 8, 21, 18, 0)));
    expect(new Date(nextRunAfter(first, everyOtherDay, first))).toEqual(new Date(local(2026, 8, 23, 18, 0)));
  });

  it("describes schedules in plain words", () => {
    expect(describeSchedule({ intervalMs: 2 * 3_600_000, daysMask: ALL_DAYS })).toBe("every 2h");
    expect(describeSchedule({ intervalMs: DAY_MS, atMinute: 480, daysMask: parseDays("weekdays") })).toBe("daily at 08:00 on weekdays");
    expect(describeSchedule({ intervalMs: 7 * DAY_MS, atMinute: 540, daysMask: parseDays("mon") })).toBe("weekly at 09:00 on mon");
  });
});
