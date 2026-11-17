import { VaultToolError } from "./memory-store.mjs";

const fail = (message) => new VaultToolError("invalid_calendar", message);
const pad = (value) => String(value).padStart(2, "0");
const dateText = (date) => `${String(date.getUTCFullYear()).padStart(4, "0")}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
const utcDate = (year, month, day) => {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  return date;
};

export function validateCalendarDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw fail("Dates must use YYYY-MM-DD.");
  const [year, month, day] = value.split("-").map(Number);
  if (year < 1 || dateText(utcDate(year, month, day)) !== value) throw fail("Date is not a valid calendar day.");
  return value;
}

function isoWeek(date) {
  const thursday = new Date(date);
  thursday.setUTCDate(thursday.getUTCDate() + 4 - (thursday.getUTCDay() || 7));
  const year = thursday.getUTCFullYear();
  const first = utcDate(year, 1, 1);
  const week = Math.ceil(((thursday - first) / 86400000 + 1) / 7);
  return `${String(year).padStart(4, "0")}-${pad(week)}`;
}

export function validateWeekKey(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}$/.test(value)) throw fail("Weeks must use ISO YYYY-WW.");
  const [year, week] = value.split("-").map(Number);
  if (year < 1 || week < 1 || week > Number(isoWeek(utcDate(year, 12, 28)).slice(5))) throw fail("Week is not valid for its ISO year.");
  return value;
}

export function workCalendar(now, settingsWeekly = {}) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw fail("Calendar requires a valid Date.");
  const timezone = settingsWeekly.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const start = settingsWeekly.workdayStart ?? "09:00";
  if (typeof start !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(start)) throw fail("workdayStart must use HH:mm.");
  let parts;
  try {
    parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, calendar: "iso8601", numberingSystem: "latn", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  } catch { throw fail("timeZone must be a valid IANA timezone."); }
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  const local = utcDate(Number(values.year), Number(values.month), Number(values.day));
  const eventDate = dateText(local);
  const weekday = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][local.getUTCDay()];
  // Shift the local calendar date, never the timestamp. DST days need not contain 24 hours.
  if (`${values.hour}:${values.minute}` < start) local.setUTCDate(local.getUTCDate() - 1);
  return { weekKey: isoWeek(local), eventDate, weekday, businessDate: dateText(local), timezone };
}

export function calendarMonthCutoff(eventDate, months) {
  validateCalendarDate(eventDate);
  if (!Number.isInteger(months) || months < 1 || months > 6) throw fail("Retention months must be an integer from 1 to 6.");
  const [year, month, day] = eventDate.split("-").map(Number);
  const target = utcDate(year, month - months, 1);
  const last = utcDate(target.getUTCFullYear(), target.getUTCMonth() + 2, 0).getUTCDate();
  target.setUTCDate(Math.min(day, last));
  return dateText(target);
}
