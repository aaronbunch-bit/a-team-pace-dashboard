import { getStore } from "@netlify/blobs";
import { isMonthKey, liveMonthKey, previousMonthKey } from "./goals.mts";

/**
 * Who was on the team in each month.
 *
 * The live `roster` store is one evolving list with an `active` flag. Removing
 * someone hides them from today's boards — and, before this archive existed,
 * from last month's boards too. `roster-months` holds `{ "YYYY-MM": RosterEntry[] }`
 * so a closed month keeps the people who belonged to it.
 */
export const ROSTER_MONTHS_STORE = "roster-months";
export const ROSTER_MONTHS_KEY = "current";

export type RosterEntry = {
  display: string;
  csv?: string;
  active?: boolean;
  [key: string]: unknown;
};
export type RosterByMonth = Record<string, RosterEntry[]>;

export function normalizeRosterEntries(roster: unknown): RosterEntry[] {
  if (!Array.isArray(roster)) return [];
  const out: RosterEntry[] = [];
  for (const raw of roster) {
    if (!raw || typeof raw !== "object") continue;
    const display = String((raw as RosterEntry).display || "").trim();
    if (!display) continue;
    const csv = String((raw as RosterEntry).csv || display).trim().toLowerCase();
    out.push({
      ...(raw as RosterEntry),
      display,
      csv,
      active: (raw as RosterEntry).active !== false,
    });
  }
  return out;
}

export async function loadRosterByMonth(): Promise<RosterByMonth> {
  try {
    const doc = await getStore(ROSTER_MONTHS_STORE).get(ROSTER_MONTHS_KEY, { type: "json" });
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) return {};
    return Object.fromEntries(
      Object.entries(doc as Record<string, unknown>).filter(
        ([month, value]) => isMonthKey(month) && Array.isArray(value)
      ).map(([month, value]) => [month, normalizeRosterEntries(value)])
    );
  } catch {
    return {};
  }
}

export async function saveRosterByMonth(doc: RosterByMonth): Promise<void> {
  await getStore(ROSTER_MONTHS_STORE).setJSON(ROSTER_MONTHS_KEY, doc);
}

/**
 * Write the live roster into the month archive, and settle the month before it
 * if nothing has settled it yet.
 *
 * The first freeze of a prior month marks everyone on the previous document as
 * active: removals belong to the live month, and last month's board should keep
 * people who were still on the list when the calendar rolled.
 */
export async function recordLiveMonthRoster(
  roster: RosterEntry[],
  previousRoster: RosterEntry[] | null,
  month = liveMonthKey()
): Promise<RosterByMonth> {
  const byMonth = await loadRosterByMonth();
  const prior = previousMonthKey(month);
  if (prior && !byMonth[prior] && previousRoster && previousRoster.length) {
    byMonth[prior] = normalizeRosterEntries(previousRoster).map((r) => ({
      ...r,
      active: true,
    }));
  }
  byMonth[month] = normalizeRosterEntries(roster);
  await saveRosterByMonth(byMonth);
  return byMonth;
}
