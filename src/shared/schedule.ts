// Weekly recurring schedule in Europe/Sarajevo.
//
// The saved schedule is a list of {day, minute} slots (day 1 = Monday ... 7 = Sunday,
// minute = minutes after local midnight). It is the single source of truth: there is no
// separately stored UTC cron. Occurrences are computed by converting the local wall-clock
// time through the real IANA time zone, so daylight-saving changes are automatic.

export const TIME_ZONE = "Europe/Sarajevo";

export interface Slot {
  day: number; // 1 = Monday ... 7 = Sunday (ISO weekday)
  minute: number; // 0 ... 1439
}

export const DEFAULT_SCHEDULE: Slot[] = [{ day: 5, minute: 5 * 60 }]; // Friday 05:00

const DAY_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DAY_LONG = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

const DAY_ALIASES: Record<string, number> = {};
const aliasList: [number, string[]][] = [
  [1, ["monday", "mon", "mo", "ponedjeljak", "pon"]],
  [2, ["tuesday", "tue", "tues", "tu", "utorak", "uto"]],
  [3, ["wednesday", "wed", "weds", "we", "srijeda", "sri"]],
  [4, ["thursday", "thu", "thur", "thurs", "th", "četvrtak", "cetvrtak", "čet", "cet"]],
  [5, ["friday", "fri", "fr", "petak", "pet"]],
  [6, ["saturday", "sat", "sa", "subota", "sub"]],
  [7, ["sunday", "sun", "su", "nedjelja", "ned"]],
];
for (const [day, names] of aliasList) for (const n of names) DAY_ALIASES[n] = day;

const FILLER = new Set(["at", "every", "each", "and", "on", "u", "i", "@"]);
export const MAX_SLOTS = 50;

export class ScheduleParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduleParseError";
  }
}

function describeToken(t: string): string {
  // Never echo arbitrarily long input back.
  const clean = t.replace(/[^\p{L}\p{N}:.\-]/gu, "?");
  return clean.length > 20 ? clean.slice(0, 20) + "…" : clean;
}

/** Parse a time token (possibly followed by an am/pm token). Returns minutes or null if not a time. */
function parseTime(tok: string, next: string | undefined): { minute: number; consumed: number } | null {
  if (tok === "noon") return { minute: 12 * 60, consumed: 1 };
  if (tok === "midnight") return { minute: 0, consumed: 1 };

  let m = /^(\d{1,2})(?::(\d{2}))?(am|pm|h)?$/.exec(tok);
  let fourDigit = false;
  if (!m) {
    const m4 = /^(\d{2})(\d{2})(h)?$/.exec(tok);
    if (!m4) return null;
    m = [tok, m4[1], m4[2], m4[3] ?? "h"] as unknown as RegExpExecArray;
    fourDigit = true;
  }
  const hourRaw = Number(m[1]);
  const minRaw = m[2] !== undefined ? Number(m[2]) : 0;
  let suffix = m[3];
  let consumed = 1;
  if (!suffix && (next === "am" || next === "pm")) {
    suffix = next;
    consumed = 2;
  }
  if (minRaw > 59) throw new ScheduleParseError(`Invalid minutes in "${describeToken(tok)}".`);
  if (suffix === "am" || suffix === "pm") {
    if (fourDigit) throw new ScheduleParseError(`"${describeToken(tok)}" mixes 24-hour digits with am/pm.`);
    if (hourRaw < 1 || hourRaw > 12) {
      throw new ScheduleParseError(`"${describeToken(tok)} ${suffix}" is not a valid 12-hour time (use 1-12 with am/pm).`);
    }
    const h = (hourRaw % 12) + (suffix === "pm" ? 12 : 0);
    return { minute: h * 60 + minRaw, consumed };
  }
  if (m[2] === undefined && suffix !== "h") {
    throw new ScheduleParseError(
      `"${describeToken(tok)}" is ambiguous: write it as ${hourRaw}am, ${hourRaw}pm or a 24-hour time such as ${String(hourRaw).padStart(2, "0")}:00.`,
    );
  }
  if (hourRaw > 23) throw new ScheduleParseError(`"${describeToken(tok)}" is not a valid 24-hour time (00:00-23:59).`);
  return { minute: hourRaw * 60 + minRaw, consumed };
}

/**
 * Parse a practical weekly schedule such as
 *   "tuesday-5pm monday-6am friday 9-pm"   or   "Tue 17:00; Mon 06:00; Fri 21:00".
 * Returns null for empty input (meaning "keep the saved schedule").
 * Throws ScheduleParseError for invalid or ambiguous input.
 */
export function parseSchedule(input: string | null | undefined): Slot[] | null {
  if (input == null) return null;
  if (input.length > 1000) throw new ScheduleParseError("Schedule text is too long (max 1000 characters).");
  let s = input.normalize("NFC").toLowerCase().trim();
  if (s === "") return null;

  s = s
    .replace(/\b([ap])\.\s?m\.?/g, "$1m") // a.m. / p.m.
    .replace(/(\d)\.(\d{2})\b/g, "$1:$2") // 17.30 -> 17:30
    .replace(/[;,|\n\r\t\-–—_/]+/g, " ")
    .replace(/(\d)\s*(am|pm)\b/g, "$1$2") // "9 pm" -> "9pm"
    .replace(/\s+/g, " ")
    .trim();

  const tokens = s.split(" ").filter((t) => t !== "" && !FILLER.has(t));
  const slots: Slot[] = [];
  let pendingDays: number[] = [];
  let groupHasTime = false;

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const day = DAY_ALIASES[tok];
    if (day !== undefined) {
      if (groupHasTime) {
        pendingDays = [];
        groupHasTime = false;
      }
      pendingDays.push(day);
      continue;
    }
    const t = parseTime(tok, tokens[i + 1]);
    if (t) {
      if (pendingDays.length === 0) {
        throw new ScheduleParseError(`Time "${describeToken(tok)}" is not preceded by a weekday (e.g. "Fri 05:00").`);
      }
      for (const d of pendingDays) slots.push({ day: d, minute: t.minute });
      groupHasTime = true;
      i += t.consumed - 1;
      continue;
    }
    throw new ScheduleParseError(
      `Unrecognised part "${describeToken(tok)}". Use weekdays with times, e.g. "Tue 17:00; Mon 06:00" or "tuesday-5pm monday-6am".`,
    );
  }
  if (pendingDays.length > 0 && !groupHasTime) {
    throw new ScheduleParseError(`Weekday "${DAY_LONG[pendingDays[0] - 1]}" has no time.`);
  }
  if (slots.length === 0) throw new ScheduleParseError("No weekday/time pairs found.");
  const norm = normalizeSlots(slots);
  if (norm.length > MAX_SLOTS) throw new ScheduleParseError(`Too many weekly slots (max ${MAX_SLOTS}).`);
  return norm;
}

/** Deduplicate and order Monday-first, then by time. */
export function normalizeSlots(slots: Slot[]): Slot[] {
  const seen = new Map<string, Slot>();
  for (const s of slots) {
    if (!Number.isInteger(s.day) || s.day < 1 || s.day > 7) throw new ScheduleParseError("Invalid weekday in slot.");
    if (!Number.isInteger(s.minute) || s.minute < 0 || s.minute > 1439) throw new ScheduleParseError("Invalid time in slot.");
    seen.set(`${s.day}:${s.minute}`, { day: s.day, minute: s.minute });
  }
  return [...seen.values()].sort((a, b) => a.day - b.day || a.minute - b.minute);
}

export function formatSlot(s: Slot): string {
  const hh = String(Math.floor(s.minute / 60)).padStart(2, "0");
  const mm = String(s.minute % 60).padStart(2, "0");
  return `${DAY_SHORT[s.day - 1]} ${hh}:${mm}`;
}

/** Canonical text form, e.g. "Mon 06:00; Tue 17:00; Fri 21:00". It parses back to the same slots. */
export function formatSchedule(slots: Slot[]): string {
  return normalizeSlots(slots).map(formatSlot).join("; ");
}

// ---------------------------------------------------------------------------
// Time-zone arithmetic (uses the runtime's IANA data via Intl; works in Node and Workers)

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number; // 1 = Monday
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

const WD: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

export function wallClock(ms: number, tz = TIME_ZONE): WallClock {
  const parts: Record<string, string> = {};
  for (const p of formatter(tz).formatToParts(new Date(ms))) parts[p.type] = p.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    weekday: WD[parts.weekday],
  };
}

/** Offset of tz from UTC at instant ms, in minutes (e.g. +60 for CET, +120 for CEST). */
export function offsetMinutes(ms: number, tz = TIME_ZONE): number {
  const w = wallClock(ms, tz);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
  const floored = Math.floor(ms / 60000) * 60000;
  return Math.round((asUtc - floored) / 60000);
}

/**
 * Convert a local wall-clock time to a UTC instant.
 * - Ambiguous (autumn fall-back) times resolve to the EARLIER instant, so a slot fires once.
 * - Non-existent (spring-forward gap) times are shifted forward by the gap length
 *   (e.g. 02:30 on the last Sunday of March becomes 03:30 CEST), the usual "compatible" rule.
 */
export function localToUtc(year: number, month: number, day: number, minuteOfDay: number, tz = TIME_ZONE): number {
  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const before = offsetMinutes(guess - 36 * 3600_000, tz);
  const after = offsetMinutes(guess + 36 * 3600_000, tz);
  const candidates: number[] = [];
  for (const off of new Set([before, after])) {
    const t = guess - off * 60000;
    const w = wallClock(t, tz);
    if (w.year === year && w.month === month && w.day === day && w.hour === hour && w.minute === minute) candidates.push(t);
  }
  if (candidates.length > 0) return Math.min(...candidates);
  return guess - before * 60000; // gap: shift forward
}

export interface Occurrence {
  key: string; // UTC instant, ISO minute precision — identical for every delivery of the same occurrence
  utcMs: number;
  slot: Slot;
  localLabel: string; // e.g. "Fri 2026-10-09 05:00 (Europe/Sarajevo, UTC+02:00)"
}

export function occurrenceKey(utcMs: number): string {
  return new Date(Math.floor(utcMs / 60000) * 60000).toISOString().slice(0, 16) + "Z";
}

export function localLabel(utcMs: number, tz = TIME_ZONE): string {
  const w = wallClock(utcMs, tz);
  const off = offsetMinutes(utcMs, tz);
  const sign = off >= 0 ? "+" : "-";
  const oh = String(Math.floor(Math.abs(off) / 60)).padStart(2, "0");
  const om = String(Math.abs(off) % 60).padStart(2, "0");
  const p = (n: number) => String(n).padStart(2, "0");
  return `${DAY_SHORT[w.weekday - 1]} ${w.year}-${p(w.month)}-${p(w.day)} ${p(w.hour)}:${p(w.minute)} (${tz}, UTC${sign}${oh}:${om})`;
}

/** All occurrences with fromMs < instant <= toMs, sorted, one per instant. */
export function occurrencesBetween(slots: Slot[], fromMs: number, toMs: number, tz = TIME_ZONE): Occurrence[] {
  if (slots.length === 0 || toMs <= fromMs) return [];
  const start = wallClock(fromMs, tz);
  const days = Math.ceil((toMs - fromMs) / 86400_000) + 2;
  const out = new Map<number, Occurrence>();
  for (let i = -1; i <= days; i++) {
    const d = new Date(Date.UTC(start.year, start.month - 1, start.day + i));
    const isoWeekday = ((d.getUTCDay() + 6) % 7) + 1;
    for (const slot of slots) {
      if (slot.day !== isoWeekday) continue;
      const t = localToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), slot.minute, tz);
      if (t > fromMs && t <= toMs && !out.has(t)) {
        out.set(t, { key: occurrenceKey(t), utcMs: t, slot, localLabel: localLabel(t, tz) });
      }
    }
  }
  return [...out.values()].sort((a, b) => a.utcMs - b.utcMs);
}

export function nextOccurrences(slots: Slot[], afterMs: number, count: number, tz = TIME_ZONE): Occurrence[] {
  if (slots.length === 0 || count <= 0) return [];
  return occurrencesBetween(slots, afterMs, afterMs + (7 * count + 8) * 86400_000, tz).slice(0, count);
}

/**
 * Is a scheduled occurrence due in the minute containing scheduledTimeMs?
 * Uses the cron event's scheduledTime (not wall-clock "now"), so a late delivery still maps to
 * the minute it was scheduled for and repeated deliveries produce the same occurrence key.
 */
export function dueOccurrence(slots: Slot[], scheduledTimeMs: number, tz = TIME_ZONE): Occurrence | null {
  const minute = Math.floor(scheduledTimeMs / 60000) * 60000;
  const occ = occurrencesBetween(slots, minute - 1, minute, tz);
  return occ.length > 0 ? occ[0] : null;
}
