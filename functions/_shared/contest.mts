/** Shared contest helpers for Netlify Functions. */

export type ContestKind = "hosted" | "promo";
export type ContestMode = "race" | "wheel";
export type ContestUnits = "sessions" | "members" | "both";
export type ContestStake = "money" | "bragging";
export type ContestStatus = "scheduled" | "active" | "ended";
export type ContestPreset = "morning" | "power-hour" | "evening" | "custom";

export type ContestManualEntry = {
  id: string;
  repName: string;
  sessions: number;
  members: number;
  note: string;
  by: string;
  at: string;
};

export type ContestRecord = {
  id: string;
  kind: ContestKind;
  name: string;
  mode: ContestMode;
  units: ContestUnits;
  stakeType: ContestStake;
  stakeAmount: number | null;
  preset: ContestPreset;
  startAt: string;
  endAt: string;
  status: ContestStatus;
  showBanner: boolean;
  externalUrl: string | null;
  repFilter: string[] | null;
  manualEntries: ContestManualEntry[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
  endedBy: string | null;
};

export const CONTEST_STORE = "contests";

export function newContestId(): string {
  return "c_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function newManualEntryId(): string {
  return "m_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export function normalizeContestPatch(body: any, existing?: ContestRecord | null): Partial<ContestRecord> {
  const name = String(body?.name ?? existing?.name ?? "").trim().slice(0, 80);
  const kindRaw = String(body?.kind ?? existing?.kind ?? "hosted");
  const kind: ContestKind = kindRaw === "promo" ? "promo" : "hosted";
  const modeRaw = String(body?.mode ?? existing?.mode ?? "race");
  const mode: ContestMode = modeRaw === "wheel" ? "wheel" : "race";
  const unitsRaw = String(body?.units ?? existing?.units ?? "sessions");
  const units: ContestUnits =
    unitsRaw === "members" ? "members" : unitsRaw === "both" ? "both" : "sessions";
  const stakeRaw = String(body?.stakeType ?? existing?.stakeType ?? "bragging");
  const stakeType: ContestStake = stakeRaw === "money" ? "money" : "bragging";
  let stakeAmount: number | null = existing?.stakeAmount ?? null;
  if (body?.stakeAmount !== undefined) {
    const n = Number(body.stakeAmount);
    stakeAmount = stakeType === "money" && Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
  } else if (stakeType !== "money") {
    stakeAmount = null;
  }
  const presetRaw = String(body?.preset ?? existing?.preset ?? "custom");
  const preset: ContestPreset =
    presetRaw === "morning" || presetRaw === "power-hour" || presetRaw === "evening"
      ? presetRaw
      : "custom";
  const startAt = String(body?.startAt ?? existing?.startAt ?? "").trim();
  const endAt = String(body?.endAt ?? existing?.endAt ?? "").trim();
  const showBanner =
    body?.showBanner === undefined ? (existing?.showBanner ?? true) : !!body.showBanner;
  const externalUrlRaw = body?.externalUrl === undefined
    ? existing?.externalUrl ?? null
    : String(body.externalUrl || "").trim().slice(0, 500) || null;
  let repFilter: string[] | null = existing?.repFilter ?? null;
  if (body?.repFilter !== undefined) {
    if (Array.isArray(body.repFilter) && body.repFilter.length) {
      repFilter = body.repFilter.map((r: any) => String(r || "").trim()).filter(Boolean);
    } else {
      repFilter = null;
    }
  }

  return {
    name,
    kind,
    mode,
    units,
    stakeType,
    stakeAmount,
    preset,
    startAt,
    endAt,
    showBanner,
    externalUrl: externalUrlRaw,
    repFilter,
  };
}

export function validateContestFields(c: Partial<ContestRecord>): string | null {
  if (!c.name) return "Contest name is required";
  if (!c.startAt || Number.isNaN(Date.parse(c.startAt))) return "Start time is required";
  if (!c.endAt || Number.isNaN(Date.parse(c.endAt))) return "End time is required";
  if (Date.parse(String(c.endAt)) <= Date.parse(String(c.startAt))) {
    return "End time must be after start time";
  }
  if (c.stakeType === "money" && !(c.stakeAmount && c.stakeAmount > 0)) {
    return "Enter a dollar amount for the pot, or switch to bragging rights";
  }
  return null;
}

/** Derive status from window when not explicitly ended. */
export function deriveContestStatus(c: ContestRecord, now = new Date()): ContestStatus {
  if (c.status === "ended") return "ended";
  const t = now.getTime();
  const start = Date.parse(c.startAt);
  const end = Date.parse(c.endAt);
  if (Number.isFinite(start) && t < start) return "scheduled";
  if (Number.isFinite(end) && t > end) return "ended";
  return "active";
}

export function publicContest(c: ContestRecord, now = new Date()): ContestRecord {
  return {
    ...c,
    status: deriveContestStatus(c, now),
    manualEntries: Array.isArray(c.manualEntries) ? c.manualEntries : [],
  };
}
