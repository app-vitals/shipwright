/**
 * admin/src/coding/system-cron-schedule.ts
 * Slot computation for the system-cron scheduler (SCR-1.3).
 *
 * The task-store stores a definition's schedule as an opaque 5-field cron
 * expression plus an IANA timezone ("semantics are the scheduler's"); this
 * module is those semantics:
 *
 *   minute 0-59 · hour 0-23 · day-of-month 1-31 · month 1-12 (JAN-DEC) ·
 *   day-of-week 0-7 (SUN-SAT, 7 = Sunday)
 *
 * Each field is a comma list of `*`, `n`, `a-b`, optionally `/step`
 * (`n/step` runs n through the field max). As in Vixie cron, when BOTH
 * day-of-month and day-of-week are restricted (don't start with `*`) a day
 * matches if EITHER does; otherwise both must.
 *
 * dueSlots() walks UTC minutes and evaluates each in the definition's
 * timezone, so a local time skipped by a spring-forward transition never
 * fires and one repeated by a fall-back fires once per occurrence (two
 * distinct instants, two slots). Every zone in use has whole-minute offsets,
 * so UTC minute boundaries are local minute boundaries.
 *
 * Pure and dependency-free: every instant is passed in.
 */

export interface CronSpec {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
  dayOfMonthRestricted: boolean;
  dayOfWeekRestricted: boolean;
}

/** Wall-clock fields of one instant in some timezone (weekday 0 = Sunday). */
export interface LocalTime {
  minute: number;
  hour: number;
  day: number;
  month: number;
  weekday: number;
}

const MONTH_NAMES = [
  "JAN",
  "FEB",
  "MAR",
  "APR",
  "MAY",
  "JUN",
  "JUL",
  "AUG",
  "SEP",
  "OCT",
  "NOV",
  "DEC",
];
const DAY_NAMES = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

interface FieldDef {
  name: string;
  min: number;
  max: number;
  /** Name → value, for month and day-of-week. */
  names?: readonly string[];
  namesOffset?: number;
}

const FIELDS: readonly FieldDef[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day-of-month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: MONTH_NAMES, namesOffset: 1 },
  { name: "day-of-week", min: 0, max: 7, names: DAY_NAMES, namesOffset: 0 },
];

function parseValue(raw: string, field: FieldDef): number {
  const upper = raw.toUpperCase();
  const named = field.names?.indexOf(upper) ?? -1;
  if (named >= 0) return named + (field.namesOffset ?? 0);
  if (!/^\d+$/.test(raw)) {
    throw new Error(`invalid ${field.name} value '${raw}'`);
  }
  const n = Number(raw);
  if (n < field.min || n > field.max) {
    throw new Error(
      `${field.name} value ${n} out of range ${field.min}-${field.max}`,
    );
  }
  return n;
}

function parseField(raw: string, field: FieldDef): Set<number> {
  const out = new Set<number>();
  for (const part of raw.split(",")) {
    const [range, stepRaw, ...rest] = part.split("/");
    if (rest.length > 0 || range === "") {
      throw new Error(`invalid ${field.name} '${part}'`);
    }
    let step = 1;
    if (stepRaw !== undefined) {
      if (!/^\d+$/.test(stepRaw) || Number(stepRaw) === 0) {
        throw new Error(`invalid ${field.name} step '${stepRaw}'`);
      }
      step = Number(stepRaw);
    }
    let lo: number;
    let hi: number;
    if (range === "*") {
      lo = field.min;
      hi = field.max;
    } else if (range.includes("-")) {
      const [a, b, ...more] = range.split("-");
      if (more.length > 0) throw new Error(`invalid ${field.name} '${part}'`);
      lo = parseValue(a, field);
      hi = parseValue(b, field);
      if (lo > hi) throw new Error(`invalid ${field.name} range '${range}'`);
    } else {
      lo = parseValue(range, field);
      hi = stepRaw === undefined ? lo : field.max;
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

/** Parses a 5-field cron expression; throws on anything invalid. */
export function parseCronSchedule(expr: string): CronSpec {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5 || parts[0] === "") {
    throw new Error(`schedule '${expr}' must have exactly 5 fields`);
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts.map((p, i) =>
    parseField(p, FIELDS[i]),
  );
  if (dayOfWeek.delete(7)) dayOfWeek.add(0);
  return {
    minute,
    hour,
    dayOfMonth,
    month,
    dayOfWeek,
    dayOfMonthRestricted: !parts[2].startsWith("*"),
    dayOfWeekRestricted: !parts[4].startsWith("*"),
  };
}

function matchesDay(spec: CronSpec, t: LocalTime): boolean {
  if (!spec.month.has(t.month)) return false;
  const dom = spec.dayOfMonth.has(t.day);
  const dow = spec.dayOfWeek.has(t.weekday);
  if (spec.dayOfMonthRestricted && spec.dayOfWeekRestricted) return dom || dow;
  return dom && dow;
}

/** True when the local wall-clock time `t` is a slot of `spec`. */
export function matchesLocal(spec: CronSpec, t: LocalTime): boolean {
  return (
    spec.minute.has(t.minute) && spec.hour.has(t.hour) && matchesDay(spec, t)
  );
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const formatters = new Map<string, Intl.DateTimeFormat>();

function localTime(instant: Date, timeZone: string): LocalTime {
  let fmt = formatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      weekday: "short",
    });
    formatters.set(timeZone, fmt);
  }
  const t: LocalTime = { minute: 0, hour: 0, day: 0, month: 0, weekday: 0 };
  for (const p of fmt.formatToParts(instant)) {
    if (p.type === "minute") t.minute = Number(p.value);
    else if (p.type === "hour") t.hour = Number(p.value);
    else if (p.type === "day") t.day = Number(p.value);
    else if (p.type === "month") t.month = Number(p.value);
    else if (p.type === "weekday") t.weekday = WEEKDAYS.indexOf(p.value);
  }
  return t;
}

const MINUTE_MS = 60_000;
/**
 * Safety margin when skipping the rest of a non-matching local day: no zone's
 * offset jumps by more than this, so stopping this far short of local
 * midnight can never step over a matching minute.
 */
const DAY_SKIP_MARGIN_MINUTES = 180;

/**
 * Every slot of `schedule` (evaluated in `timeZone`) strictly after `after`
 * and at or before `until`, oldest first. Throws on an invalid schedule or
 * timezone. Unbounded by design (SCR-1.3 catch-up has no cap); a day that
 * can't match is skipped in one jump rather than minute by minute.
 */
export function dueSlots(
  schedule: string | CronSpec,
  timeZone: string,
  after: Date,
  until: Date,
): Date[] {
  const spec =
    typeof schedule === "string" ? parseCronSchedule(schedule) : schedule;
  const slots: Date[] = [];
  let t = (Math.floor(after.getTime() / MINUTE_MS) + 1) * MINUTE_MS;
  const end = until.getTime();
  while (t <= end) {
    const local = localTime(new Date(t), timeZone);
    if (!matchesDay(spec, local)) {
      const toMidnight = 24 * 60 - (local.hour * 60 + local.minute);
      t += Math.max(1, toMidnight - DAY_SKIP_MARGIN_MINUTES) * MINUTE_MS;
      continue;
    }
    if (spec.minute.has(local.minute) && spec.hour.has(local.hour)) {
      slots.push(new Date(t));
    }
    t += MINUTE_MS;
  }
  return slots;
}
