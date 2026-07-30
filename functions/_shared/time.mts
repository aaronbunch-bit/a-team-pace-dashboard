/** Team business calendar — Central Time (CST/CDT). */
export const TEAM_TIME_ZONE = "America/Chicago";

/** Calendar YYYY-MM-DD in America/Chicago (handles CST/CDT). */
export function ymdInTimeZone(date: Date = new Date(), timeZone: string = TEAM_TIME_ZONE): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** Today's date on the team calendar. */
export function teamTodayYmd(date: Date = new Date()): string {
  return ymdInTimeZone(date, TEAM_TIME_ZONE);
}

/** Today's YYYY-MM month key on the team calendar. */
export function teamTodayMonthKey(date: Date = new Date()): string {
  return teamTodayYmd(date).slice(0, 7);
}

/** Cap an as-of date so it never runs ahead of the team calendar day. */
export function clampAsOfToTeamToday(asOf: string | null | undefined, now: Date = new Date()): string {
  const today = teamTodayYmd(now);
  const raw = String(asOf || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return today;
  return raw > today ? today : raw;
}
