/** Shared contest helpers for Netlify Functions. */

export type ContestKind = "hosted" | "promo";
export type ContestMode = "race" | "wheel";
export type ContestUnits = "sessions" | "members" | "both";
export type ContestStake = "money" | "bragging";
export type ContestStatus = "scheduled" | "active" | "ended";
export type ContestPreset = "morning" | "power-hour" | "evening" | "custom";
export type ContestVehicle =
  | "car"
  | "rocket"
  | "horse"
  | "turtle"
  | "bolt"
  | "runner"
  | "bike"
  | "boat"
  | "kart"
  | "dragon";
export type ContestTrackTheme = "asphalt" | "neon" | "desert" | "rainbow" | "ice" | "stadium";
export type ContestHype = "chill" | "hype" | "max";
export type ContestAccent = "pink" | "gold" | "cyan" | "lime" | "orange" | "violet";
export type ContestWheelSkin = "classic" | "neon" | "candy" | "midnight" | "gold";

export type ContestManualEntry = {
  id: string;
  repName: string;
  sessions: number;
  members: number;
  note: string;
  by: string;
  at: string;
};

/** Frozen leaderboard row for contest history. */
export type ContestStandingSnap = {
  place: number;
  repName: string;
  sessions: number;
  members: number;
  score: number;
  tickets: number;
  manual: number;
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
  /** Race vehicle emoji/style on the speedway. */
  vehicle: ContestVehicle;
  /** Speedway backdrop theme. */
  trackTheme: ContestTrackTheme;
  /** Motion + announcer intensity. */
  hypeLevel: ContestHype;
  /** Accent palette for cars / chips. */
  accent: ContestAccent;
  /** Optional finish-line target (score units). null = relative to leader. */
  raceGoal: number | null;
  /** Custom tagline under the contest name. */
  tagline: string | null;
  /** Show detailed lane board under the speedway. */
  showLaneBoard: boolean;
  /** Fun announcer callouts when lead changes. */
  announcer: boolean;
  /** Wheel color skin (wheel mode). */
  wheelSkin: ContestWheelSkin;
  /** When true, ended contest is hidden from History for reps (coaches still see it). */
  hiddenFromHistory: boolean;
  /** Snapshot taken when contest ends — used for History leaderboards. */
  finalStandings: ContestStandingSnap[] | null;
  manualEntries: ContestManualEntry[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
  endedBy: string | null;
};

export const CONTEST_STORE = "contests";

const VEHICLES: ContestVehicle[] = [
  "car", "rocket", "horse", "turtle", "bolt", "runner", "bike", "boat", "kart", "dragon",
];
const TRACKS: ContestTrackTheme[] = ["asphalt", "neon", "desert", "rainbow", "ice", "stadium"];
const HYPES: ContestHype[] = ["chill", "hype", "max"];
const ACCENTS: ContestAccent[] = ["pink", "gold", "cyan", "lime", "orange", "violet"];
const WHEEL_SKINS: ContestWheelSkin[] = ["classic", "neon", "candy", "midnight", "gold"];

function pickEnum<T extends string>(raw: string, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
}

export function newContestId(): string {
  return "c_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function newManualEntryId(): string {
  return "m_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export function normalizeFinalStandings(raw: any): ContestStandingSnap[] | null {
  if (!Array.isArray(raw) || !raw.length) return null;
  const rows: ContestStandingSnap[] = raw
    .map((r: any, i: number) => {
      const repName = String(r?.repName || "").trim().slice(0, 80);
      if (!repName) return null;
      const sessions = Number(r?.sessions) || 0;
      const members = Number(r?.members) || 0;
      const score = Number(r?.score);
      const tickets = Number(r?.tickets);
      const manual = Number(r?.manual) || 0;
      const place = Number(r?.place);
      return {
        repName,
        sessions,
        members,
        score: Number.isFinite(score) ? score : 0,
        tickets: Number.isFinite(tickets) ? tickets : Math.max(0, Number.isFinite(score) ? score : 0),
        manual: Number.isFinite(manual) ? manual : 0,
        place: Number.isFinite(place) && place > 0 ? place : i + 1,
      } as ContestStandingSnap;
    })
    .filter(Boolean) as ContestStandingSnap[];
  if (!rows.length) return null;
  rows.sort((a, b) => a.place - b.place || b.score - a.score || a.repName.localeCompare(b.repName));
  return rows.slice(0, 80);
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

  const vehicle = pickEnum(
    String(body?.vehicle ?? existing?.vehicle ?? "car"),
    VEHICLES,
    "car",
  );
  const trackTheme = pickEnum(
    String(body?.trackTheme ?? existing?.trackTheme ?? "asphalt"),
    TRACKS,
    "asphalt",
  );
  const hypeLevel = pickEnum(
    String(body?.hypeLevel ?? existing?.hypeLevel ?? "hype"),
    HYPES,
    "hype",
  );
  const accent = pickEnum(
    String(body?.accent ?? existing?.accent ?? "pink"),
    ACCENTS,
    "pink",
  );
  const wheelSkin = pickEnum(
    String(body?.wheelSkin ?? existing?.wheelSkin ?? "classic"),
    WHEEL_SKINS,
    "classic",
  );

  let raceGoal: number | null = existing?.raceGoal ?? null;
  if (body?.raceGoal !== undefined) {
    const n = Number(body.raceGoal);
    raceGoal = Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
  }

  const taglineRaw = body?.tagline === undefined
    ? existing?.tagline ?? null
    : String(body.tagline || "").trim().slice(0, 120) || null;

  const showLaneBoard =
    body?.showLaneBoard === undefined
      ? (existing?.showLaneBoard ?? true)
      : !!body.showLaneBoard;
  const announcer =
    body?.announcer === undefined ? (existing?.announcer ?? true) : !!body.announcer;
  const hiddenFromHistory =
    body?.hiddenFromHistory === undefined
      ? (existing?.hiddenFromHistory ?? false)
      : !!body.hiddenFromHistory;

  let finalStandings: ContestStandingSnap[] | null = existing?.finalStandings ?? null;
  if (body?.finalStandings !== undefined) {
    // Allow setting once; coaches can overwrite via explicit freeze.
    const next = normalizeFinalStandings(body.finalStandings);
    if (next) finalStandings = next;
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
    vehicle,
    trackTheme,
    hypeLevel,
    accent,
    raceGoal,
    tagline: taglineRaw,
    showLaneBoard,
    announcer,
    wheelSkin,
    hiddenFromHistory,
    finalStandings,
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
    vehicle: c.vehicle || "car",
    trackTheme: c.trackTheme || "asphalt",
    hypeLevel: c.hypeLevel || "hype",
    accent: c.accent || "pink",
    raceGoal: c.raceGoal ?? null,
    tagline: c.tagline ?? null,
    showLaneBoard: c.showLaneBoard !== false,
    announcer: c.announcer !== false,
    wheelSkin: c.wheelSkin || "classic",
    hiddenFromHistory: !!c.hiddenFromHistory,
    finalStandings: Array.isArray(c.finalStandings) ? c.finalStandings : null,
    manualEntries: Array.isArray(c.manualEntries) ? c.manualEntries : [],
  };
}
