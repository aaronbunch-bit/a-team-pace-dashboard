import { getStore } from "@netlify/blobs";
import { isMonthKey } from "./goals.mts";

export const TEAM_MONTH_SETTINGS_STORE = "team-month-settings";
export const TEAM_MONTH_SETTINGS_KEY = "current";
export const PGC_METRIC_MAX = 12;

export type PgcMetric = {
  id: string;
  label: string;
  percent: number;
};

export type TeamMonthSetting = {
  pgcMetrics: PgcMetric[];
};

export type TeamMonthSettingsDoc = Record<string, TeamMonthSetting>;

function newPgcMetricId(): string {
  return `pgc_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}

function normalizePercent(raw: unknown): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

export function normalizePgcMetric(raw: unknown, fallbackId?: string): PgcMetric {
  const source = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const id = String(source.id || fallbackId || "").trim() || newPgcMetricId();
  const percentRaw = source.percent !== undefined ? source.percent : source.pgcValue;
  return {
    id: id.slice(0, 40),
    label: String(source.label || source.pgcLabel || "").trim().slice(0, 80),
    percent: normalizePercent(percentRaw),
  };
}

function metricsFromLegacy(source: Record<string, unknown>): PgcMetric[] {
  const hasLegacy =
    source.pgcLabel !== undefined ||
    source.pgcValue !== undefined ||
    source.label !== undefined ||
    source.percent !== undefined;
  if (!hasLegacy) return [];
  const metric = normalizePgcMetric({
    label: source.pgcLabel ?? source.label,
    percent: source.pgcValue ?? source.percent,
  });
  // Drop a completely empty legacy shell so months with no pGC stay empty.
  if (!metric.label && metric.percent === 0) return [];
  return [metric];
}

export function normalizeTeamMonthSetting(raw: unknown): TeamMonthSetting {
  const source = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};

  let metrics: PgcMetric[] = [];
  if (Array.isArray(source.pgcMetrics)) {
    metrics = source.pgcMetrics
      .map((item) => normalizePgcMetric(item))
      .slice(0, PGC_METRIC_MAX);
  } else {
    metrics = metricsFromLegacy(source).slice(0, PGC_METRIC_MAX);
  }

  return { pgcMetrics: metrics };
}

/** Persist-friendly normalize: drop fully empty trailing rows. */
export function normalizeTeamMonthSettingForSave(raw: unknown): TeamMonthSetting {
  const setting = normalizeTeamMonthSetting(raw);
  return {
    pgcMetrics: setting.pgcMetrics
      .filter((m) => m.label.trim() !== "" || m.percent !== 0)
      .slice(0, PGC_METRIC_MAX),
  };
}

export function normalizeTeamMonthSettingsDoc(raw: unknown): TeamMonthSettingsDoc {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>)
      .filter(([month]) => isMonthKey(month))
      .map(([month, setting]) => [month, normalizeTeamMonthSettingForSave(setting)]),
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
