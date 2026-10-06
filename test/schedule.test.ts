import { describe, expect, it } from "vitest";
import {
  DEFAULT_SCHEDULE,
  ScheduleParseError,
  dueOccurrence,
  formatSchedule,
  localToUtc,
  nextOccurrences,
  occurrencesBetween,
  parseSchedule,
} from "../src/shared/schedule";

const t = (s: string) => Date.parse(s);

describe("schedule parsing", () => {
  it("normalizes the practical example", () => {
    const slots = parseSchedule("tuesday-5pm monday-6am friday 9-pm")!;
    expect(formatSchedule(slots)).toBe("Mon 06:00; Tue 17:00; Fri 21:00");
  });

  it("accepts the canonical format and round-trips it", () => {
    const slots = parseSchedule("Tue 17:00; Mon 06:00; Fri 21:00")!;
    expect(formatSchedule(slots)).toBe("Mon 06:00; Tue 17:00; Fri 21:00");
    expect(parseSchedule(formatSchedule(slots))).toEqual(slots);
  });

  it("handles case, abbreviations, whitespace, 12h and 24h notations", () => {
    expect(formatSchedule(parseSchedule("  WED   7:30 PM ,  thurs 07.15  sat 12am  sun 12pm ")!)).toBe(
      "Wed 19:30; Thu 07:15; Sat 00:00; Sun 12:00",
    );
    expect(formatSchedule(parseSchedule("Fri 5 a.m.")!)).toBe("Fri 05:00");
    expect(formatSchedule(parseSchedule("mon 0600, tue 17h")!)).toBe("Mon 06:00; Tue 17:00");
    expect(formatSchedule(parseSchedule("every friday at 5am and monday at noon")!)).toBe("Mon 12:00; Fri 05:00");
    expect(formatSchedule(parseSchedule("petak 05:00; ponedjeljak 18:00")!)).toBe("Mon 18:00; Fri 05:00");
  });

  it("applies one time to several preceding days and several times to one day", () => {
    expect(formatSchedule(parseSchedule("mon wed 5pm")!)).toBe("Mon 17:00; Wed 17:00");
    expect(formatSchedule(parseSchedule("mon 6am 6pm tue 5pm")!)).toBe("Mon 06:00; Mon 18:00; Tue 17:00");
  });

  it("deduplicates repeated slots and orders consistently", () => {
    expect(formatSchedule(parseSchedule("fri 5pm; Friday 17:00; friday 5 PM; mon 1am")!)).toBe("Mon 01:00; Fri 17:00");
  });

  it("returns null for empty input (keep saved schedule)", () => {
    expect(parseSchedule("")).toBeNull();
    expect(parseSchedule("   ")).toBeNull();
    expect(parseSchedule(undefined)).toBeNull();
  });

  it.each([
    ["friday 9", /ambiguous/],
    ["5pm", /weekday/],
    ["friday", /no time/],
    ["fri 13pm", /12-hour/],
    ["fri 0am", /12-hour/],
    ["fri 24:00", /24-hour/],
    ["fri 10:75", /minutes/],
    ["funday 5pm", /Unrecognised/],
    ["2026-10-09 05:00", /Unrecognised|weekday|ambiguous/],
  ])("rejects %s", (input, msg) => {
    expect(() => parseSchedule(input)).toThrow(ScheduleParseError);
    expect(() => parseSchedule(input)).toThrow(msg);
  });

  it("default is Friday 05:00", () => {
    expect(formatSchedule(DEFAULT_SCHEDULE)).toBe("Fri 05:00");
  });
});

describe("Europe/Sarajevo conversion", () => {
  it("uses CET in winter and CEST in summer", () => {
    expect(new Date(localToUtc(2026, 1, 9, 300)).toISOString()).toBe("2026-01-09T04:00:00.000Z");
    expect(new Date(localToUtc(2026, 7, 10, 300)).toISOString()).toBe("2026-07-10T03:00:00.000Z");
  });

  it("spring-forward gap times shift forward by the gap", () => {
    // 2027-03-28: 02:00 CET -> 03:00 CEST. 02:30 does not exist -> 03:30 CEST = 01:30Z
    expect(new Date(localToUtc(2027, 3, 28, 150)).toISOString()).toBe("2027-03-28T01:30:00.000Z");
  });

  it("fall-back ambiguous times fire once, at the earlier instant", () => {
    // 2026-10-25: 03:00 CEST -> 02:00 CET. 02:30 happens twice; we take 02:30 CEST = 00:30Z
    expect(new Date(localToUtc(2026, 10, 25, 150)).toISOString()).toBe("2026-10-25T00:30:00.000Z");
    const slots = parseSchedule("sun 02:30")!;
    const occ = occurrencesBetween(slots, t("2026-10-24T00:00Z"), t("2026-10-26T00:00Z"));
    expect(occ).toHaveLength(1);
  });

  it("next Friday 05:00 occurrences straddle the DST change", () => {
    const occ = nextOccurrences(DEFAULT_SCHEDULE, t("2026-10-06T19:00Z"), 3);
    expect(occ.map((o) => o.key)).toEqual(["2026-10-09T03:00Z", "2026-10-16T03:00Z", "2026-10-23T03:00Z"]);
    const after = nextOccurrences(DEFAULT_SCHEDULE, t("2026-10-24T00:00Z"), 1);
    expect(after[0].key).toBe("2026-10-30T04:00Z"); // CET again
    expect(after[0].localLabel).toBe("Fri 2026-10-30 05:00 (Europe/Sarajevo, UTC+01:00)");
  });

  it("handles midnight boundaries (local Monday 00:30 is Sunday in UTC)", () => {
    const slots = parseSchedule("mon 00:30")!;
    const occ = nextOccurrences(slots, t("2026-10-10T00:00Z"), 1);
    expect(occ[0].key).toBe("2026-10-11T22:30Z"); // Sunday 22:30 UTC = Monday 00:30 CEST
    expect(occ[0].localLabel.startsWith("Mon 2026-10-12 00:30")).toBe(true);
    const late = nextOccurrences(parseSchedule("sun 23:59")!, t("2026-12-01T00:00Z"), 1);
    expect(late[0].key).toBe("2026-12-06T22:59Z");
  });

  it("dueOccurrence matches only the exact scheduled minute and is stable across deliveries", () => {
    const k1 = dueOccurrence(DEFAULT_SCHEDULE, t("2026-10-09T03:00:00Z"))!;
    const k2 = dueOccurrence(DEFAULT_SCHEDULE, t("2026-10-09T03:00:59.900Z"))!;
    expect(k1.key).toBe("2026-10-09T03:00Z");
    expect(k2.key).toBe(k1.key);
    expect(dueOccurrence(DEFAULT_SCHEDULE, t("2026-10-09T02:59:00Z"))).toBeNull();
    expect(dueOccurrence(DEFAULT_SCHEDULE, t("2026-10-09T03:01:00Z"))).toBeNull();
    // 05:00 local in UTC terms in winter does not fire at the summer instant
    expect(dueOccurrence(DEFAULT_SCHEDULE, t("2026-11-06T03:00Z"))).toBeNull();
    expect(dueOccurrence(DEFAULT_SCHEDULE, t("2026-11-06T04:00Z"))!.key).toBe("2026-11-06T04:00Z");
  });
});
