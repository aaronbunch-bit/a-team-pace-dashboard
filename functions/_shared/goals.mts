import { getStore } from "@netlify/blobs";
import { teamTodayMonthKey } from "./time.mts";

/**
 * Team quotas, per month.
 *
 * The `goals` store holds one document under "current": the quotas in force
 * right now. That is all the dashboard ever had, which meant last month's
 * views read this month's numbers — change or clear a quota for August and
 * July's page changed with it, because there was nothing else to read.
 *
 * `goals-months` holds `{ "YYYY-MM": goalsDoc }`: what each month's quotas
 * actually were. A month written here is settled and no later edit to the
 * live quotas touches it.
 */
export const GOALS_MONTHS_STORE = "goals-months";
export const GOALS_MONTHS_KEY = "current";

export type GoalsDoc = Record<string, Record<string, unknown>>;
export type GoalsByMonth = Record<string, GoalsDoc>;

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function isMonthKey(value: unknown): value is string {
  return typeof value === "string" && MONTH_RE.test(value);
}

/** The month before `month` ("2026-01" -> "2025-12"). */
export function previousMonthKey(month: string): string {
  if (!isMonthKey(month)) return "";
  const [y, m] = month.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

export function liveMonthKey(): string {
  return teamTodayMonthKey();
}

export async function loadGoalsByMonth(): Promise<GoalsByMonth> {
  try {
    const doc = await getStore(GOALS_MONTHS_STORE).get(GOALS_MONTHS_KEY, { type: "json" });
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) return {};
    return Object.fromEntries(
      Object.entries(doc as Record<string, unknown>).filter(
        ([month, value]) => isMonthKey(month) && !!value && typeof value === "object"
      )
    ) as GoalsByMonth;
  } catch {
    return {};
  }
}

export async function saveGoalsByMonth(doc: GoalsByMonth): Promise<void> {
  await getStore(GOALS_MONTHS_STORE).setJSON(GOALS_MONTHS_KEY, doc);
}

/**
 * Write the live quotas into the month archive, and settle the month before it
 * if nothing has settled it yet.
 *
 * `previousGoals` is the document being replaced. When last month was never
 * written — the usual case the first time quotas are edited after a rollover —
 * those are the quotas that were in force for it, so they are what gets frozen.
 * A month already in the archive is never overwritten from here.
 */
export async function recordLiveMonthGoals(
  goals: GoalsDoc,
  previousGoals: GoalsDoc | null,
  month = liveMonthKey()
): Promise<GoalsByMonth> {
  const byMonth = await loadGoalsByMonth();
  const prior = previousMonthKey(month);
  if (prior && !byMonth[prior] && previousGoals && Object.keys(previousGoals).length) {
    byMonth[prior] = previousGoals;
  }
  byMonth[month] = goals;
  await saveGoalsByMonth(byMonth);
  return byMonth;
}
