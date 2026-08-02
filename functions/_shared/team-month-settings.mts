import { getStore } from "@netlify/blobs";
import { isMonthKey } from "./goals.mts";

export const TEAM_MONTH_SETTINGS_STORE = "team-month-settings";
export const TEAM_MONTH_SETTINGS_KEY = "current";

export type TeamMonthSetting = {
  pgcLabel: string;
  pgcValue: number;
};

export type TeamMonthSettingsDoc = Record<string, TeamMonthSetting>;

export function normalizeTeamMonthSetting(raw: unknown): TeamMonthSetting {
  const source = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const value = Number(source.pgcValue);
  return {
    pgcLabel: String(source.pgcLabel || "").trim().slice(0, 80),
    // pGC is always a plain, non-negative number — never a percentage/unit.
    pgcValue: Number.isFinite(value) ? Math.max(0, value) : 0,
  };
}

export function normalizeTeamMonthSettingsDoc(raw: unknown): TeamMonthSettingsDoc {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>)
      .filter(([month]) => isMonthKey(month))
      .map(([month, setting]) => [month, normalizeTeamMonthSetting(setting)]),
  );
}

export async function loadTeamMonthSettings(): Promise<TeamMonthSettingsDoc> {
  const raw = await getStore(TEAM_MONTH_SETTINGS_STORE).get(TEAM_MONTH_SETTINGS_KEY, { type: "json" });
  return normalizeTeamMonthSettingsDoc(raw);
}

export async function saveTeamMonthSettings(doc: TeamMonthSettingsDoc): Promise<void> {
  await getStore(TEAM_MONTH_SETTINGS_STORE).setJSON(
    TEAM_MONTH_SETTINGS_KEY,
    normalizeTeamMonthSettingsDoc(doc),
  );
}
