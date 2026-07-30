/** Shared contest helpers for Netlify Functions. */

export type ContestKind = "hosted" | "promo";
export type ContestMode = "race" | "wheel";
export type ContestUnits = "sessions" | "members" | "both";
export type ContestStake = "money" | "bragging";
export type ContestStatus = "scheduled" | "active" | "ended";

/** Full-arena visual theme (replaces old morning/power-hour/evening timing presets). */
export type ContestTheme =
  | "grand-prix"
  | "neon-night"
  | "space-race"
  | "desert-rally"
  | "rainbow-road"
  | "ice-circuit"
  | "stadium"
  | "carnival"
  | "pirate"
  | "arcade"
  | "blood-type-a"
  | "dragon-cup"
  | "underwater"
  | "retro";

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
  | "dragon"
  | "blood-a"
  | "unicorn"
  | "alien"
  | "crown"
  | "pizza"
  | "ghost"
  | "hotdog"
  | "phoenix";

export type ContestTrackTheme =
  | "asphalt"
  | "neon"
  | "desert"
  | "rainbow"
  | "ice"
  | "stadium"
  | "space"
  | "ocean"
  | "lava"
  | "pixel";

export type ContestHype = "chill" | "hype" | "max";
export type ContestAccent = "pink" | "gold" | "cyan" | "lime" | "orange" | "violet" | "red" | "blood";
export type ContestWheelSkin = "classic" | "neon" | "candy" | "midnight" | "gold" | "blood" | "pixel";
export type ContestEffects = "none" | "sparks" | "confetti" | "fireworks" | "max";
export type ContestCheer = "announcer" | "hype-crew" | "radio" | "silent";
export type ContestBoardSize = "normal" | "hero";

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
  /** @deprecated old timing preset — migrated into theme on read */
  preset?: string | null;
  /** Full-page contest arena theme */
  theme: ContestTheme;
  startAt: string;
  endAt: string;
  status: ContestStatus;
  showBanner: boolean;
  externalUrl: string | null;
  repFilter: string[] | null;
  vehicle: ContestVehicle;
  trackTheme: ContestTrackTheme;
  hypeLevel: ContestHype;
  accent: ContestAccent;
  raceGoal: number | null;
  tagline: string | null;
  showLaneBoard: boolean;
  announcer: boolean;
  wheelSkin: ContestWheelSkin;
  /** Arena mascot emoji (defaults from theme / vehicle). */
  mascot: string | null;
  /** Particle / celebration intensity. */
  effects: ContestEffects;
  /** Voice of the live callouts. */
  cheerStyle: ContestCheer;
  /** Confetti burst when the lead changes. */
  confettiOnLead: boolean;
  /** Show a live “moves” ticker under the board. */
  showTicker: boolean;
  /** Speedway dominates the page when hero. */
  boardSize: ContestBoardSize;
  /** Optional coach-written cheer that rotates in. */
  customCheer: string | null;
  /** Short dry-run contest — does not end other live contests when saved. */
  isTest: boolean;
  hiddenFromHistory: boolean;
  finalStandings: ContestStandingSnap[] | null;
  manualEntries: ContestManualEntry[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
  endedBy: string | null;
};

export const CONTEST_STORE = "contests";

export const CONTEST_THEMES: ContestTheme[] = [
  "grand-prix", "neon-night", "space-race", "desert-rally", "rainbow-road",
  "ice-circuit", "stadium", "carnival", "pirate", "arcade",
  "blood-type-a", "dragon-cup", "underwater", "retro",
];

const VEHICLES: ContestVehicle[] = [
  "car", "rocket", "horse", "turtle", "bolt", "runner", "bike", "boat", "kart", "dragon",
  "blood-a", "unicorn", "alien", "crown", "pizza", "ghost", "hotdog", "phoenix",
];
const TRACKS: ContestTrackTheme[] = [
  "asphalt", "neon", "desert", "rainbow", "ice", "stadium", "space", "ocean", "lava", "pixel",
];
const HYPES: ContestHype[] = ["chill", "hype", "max"];
const ACCENTS: ContestAccent[] = ["pink", "gold", "cyan", "lime", "orange", "violet", "red", "blood"];
const WHEEL_SKINS: ContestWheelSkin[] = ["classic", "neon", "candy", "midnight", "gold", "blood", "pixel"];
const EFFECTS: ContestEffects[] = ["none", "sparks", "confetti", "fireworks", "max"];
const CHEERS: ContestCheer[] = ["announcer", "hype-crew", "radio", "silent"];
const BOARD_SIZES: ContestBoardSize[] = ["normal", "hero"];

const THEME_DEFAULTS: Record<ContestTheme, Partial<ContestRecord>> = {
  "grand-prix": { vehicle: "car", trackTheme: "asphalt", accent: "gold", mascot: "🏁", effects: "confetti", mode: "race" },
  "neon-night": { vehicle: "kart", trackTheme: "neon", accent: "cyan", mascot: "🌃", effects: "sparks", mode: "race" },
  "space-race": { vehicle: "rocket", trackTheme: "space", accent: "violet", mascot: "🚀", effects: "max", mode: "race" },
  "desert-rally": { vehicle: "car", trackTheme: "desert", accent: "orange", mascot: "🏜️", effects: "sparks", mode: "race" },
  "rainbow-road": { vehicle: "kart", trackTheme: "rainbow", accent: "pink", mascot: "🌈", effects: "confetti", mode: "race" },
  "ice-circuit": { vehicle: "car", trackTheme: "ice", accent: "cyan", mascot: "❄️", effects: "sparks", mode: "race" },
  stadium: { vehicle: "runner", trackTheme: "stadium", accent: "lime", mascot: "🏟️", effects: "fireworks", mode: "race" },
  carnival: { vehicle: "unicorn", trackTheme: "rainbow", accent: "pink", mascot: "🎡", effects: "confetti", mode: "wheel", wheelSkin: "candy" },
  pirate: { vehicle: "boat", trackTheme: "ocean", accent: "gold", mascot: "🏴‍☠️", effects: "sparks", mode: "race" },
  arcade: { vehicle: "ghost", trackTheme: "pixel", accent: "violet", mascot: "👾", effects: "max", mode: "race" },
  "blood-type-a": { vehicle: "blood-a", trackTheme: "lava", accent: "blood", mascot: "🅰️", effects: "max", mode: "race" },
  "dragon-cup": { vehicle: "dragon", trackTheme: "lava", accent: "orange", mascot: "🐉", effects: "fireworks", mode: "race" },
  underwater: { vehicle: "boat", trackTheme: "ocean", accent: "cyan", mascot: "🐠", effects: "sparks", mode: "race" },
  retro: { vehicle: "car", trackTheme: "pixel", accent: "gold", mascot: "📼", effects: "confetti", mode: "race" },
};

function pickEnum<T extends string>(raw: string, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
}

export function migrateLegacyTheme(rawTheme: any, legacyPreset: any): ContestTheme {
  const t = String(rawTheme || "").trim();
  if ((CONTEST_THEMES as string[]).includes(t)) return t as ContestTheme;
  const p = String(legacyPreset || "").trim();
  if (p === "morning") return "desert-rally";
  if (p === "evening") return "neon-night";
  if (p === "power-hour") return "grand-prix";
  return "grand-prix";
}

export function themeDefaults(theme: ContestTheme): Partial<ContestRecord> {
  return { ...(THEME_DEFAULTS[theme] || THEME_DEFAULTS["grand-prix"]) };
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

function sanitizeMascot(raw: any): string | null {
  const s = String(raw || "").trim().slice(0, 8);
  return s || null;
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

  const theme = migrateLegacyTheme(
    body?.theme ?? existing?.theme,
    body?.preset ?? existing?.preset,
  );
  const defaults = themeDefaults(theme);

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
    String(body?.vehicle ?? existing?.vehicle ?? defaults.vehicle ?? "car"),
    VEHICLES,
    "car",
  );
  const trackTheme = pickEnum(
    String(body?.trackTheme ?? existing?.trackTheme ?? defaults.trackTheme ?? "asphalt"),
    TRACKS,
    "asphalt",
  );
  const hypeLevel = pickEnum(
    String(body?.hypeLevel ?? existing?.hypeLevel ?? "hype"),
    HYPES,
    "hype",
  );
  const accent = pickEnum(
    String(body?.accent ?? existing?.accent ?? defaults.accent ?? "pink"),
    ACCENTS,
    "pink",
  );
  const wheelSkin = pickEnum(
    String(body?.wheelSkin ?? existing?.wheelSkin ?? defaults.wheelSkin ?? "classic"),
    WHEEL_SKINS,
    "classic",
  );
  const effects = pickEnum(
    String(body?.effects ?? existing?.effects ?? defaults.effects ?? "confetti"),
    EFFECTS,
    "confetti",
  );
  const cheerStyle = pickEnum(
    String(body?.cheerStyle ?? existing?.cheerStyle ?? "announcer"),
    CHEERS,
    "announcer",
  );
  const boardSize = pickEnum(
    String(body?.boardSize ?? existing?.boardSize ?? "hero"),
    BOARD_SIZES,
    "hero",
  );

  let raceGoal: number | null = existing?.raceGoal ?? null;
  if (body?.raceGoal !== undefined) {
    const n = Number(body.raceGoal);
    raceGoal = Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
  }

  const taglineRaw = body?.tagline === undefined
    ? existing?.tagline ?? null
    : String(body.tagline || "").trim().slice(0, 120) || null;
  const customCheerRaw = body?.customCheer === undefined
    ? existing?.customCheer ?? null
    : String(body.customCheer || "").trim().slice(0, 140) || null;

  let mascot: string | null = existing?.mascot ?? defaults.mascot ?? null;
  if (body?.mascot !== undefined) {
    mascot = sanitizeMascot(body.mascot) || defaults.mascot || "🏁";
  }

  const showLaneBoard =
    body?.showLaneBoard === undefined
      ? (existing?.showLaneBoard ?? true)
      : !!body.showLaneBoard;
  const announcer =
    body?.announcer === undefined ? (existing?.announcer ?? true) : !!body.announcer;
  const confettiOnLead =
    body?.confettiOnLead === undefined
      ? (existing?.confettiOnLead ?? true)
      : !!body.confettiOnLead;
  const showTicker =
    body?.showTicker === undefined ? (existing?.showTicker ?? true) : !!body.showTicker;
  const hiddenFromHistory =
    body?.hiddenFromHistory === undefined
      ? (existing?.hiddenFromHistory ?? false)
      : !!body.hiddenFromHistory;
  const isTest =
    body?.isTest === undefined ? !!(existing?.isTest) : !!body.isTest;

  let finalStandings: ContestStandingSnap[] | null = existing?.finalStandings ?? null;
  if (body?.finalStandings !== undefined) {
    const next = normalizeFinalStandings(body.finalStandings);
    if (next) finalStandings = next;
  }

  // Mode: prefer explicit body, else theme default when creating new.
  const resolvedMode: ContestMode =
    body?.mode !== undefined
      ? mode
      : existing?.mode
        ? (existing.mode === "wheel" ? "wheel" : "race")
        : ((defaults.mode as ContestMode) || "race");

  return {
    name,
    kind,
    mode: resolvedMode,
    units,
    stakeType,
    stakeAmount,
    theme,
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
    mascot,
    effects,
    cheerStyle,
    confettiOnLead,
    showTicker,
    boardSize,
    customCheer: customCheerRaw,
    isTest,
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
  const theme = migrateLegacyTheme(c.theme, c.preset);
  const defaults = themeDefaults(theme);
  return {
    ...c,
    status: deriveContestStatus(c, now),
    theme,
    vehicle: c.vehicle || defaults.vehicle || "car",
    trackTheme: c.trackTheme || defaults.trackTheme || "asphalt",
    hypeLevel: c.hypeLevel || "hype",
    accent: c.accent || defaults.accent || "pink",
    raceGoal: c.raceGoal ?? null,
    tagline: c.tagline ?? null,
    showLaneBoard: c.showLaneBoard !== false,
    announcer: c.announcer !== false,
    wheelSkin: c.wheelSkin || defaults.wheelSkin || "classic",
    mascot: c.mascot || defaults.mascot || "🏁",
    effects: c.effects || defaults.effects || "confetti",
    cheerStyle: c.cheerStyle || "announcer",
    confettiOnLead: c.confettiOnLead !== false,
    showTicker: c.showTicker !== false,
    boardSize: c.boardSize || "hero",
    customCheer: c.customCheer ?? null,
    isTest: !!c.isTest,
    hiddenFromHistory: !!c.hiddenFromHistory,
    finalStandings: Array.isArray(c.finalStandings) ? c.finalStandings : null,
    manualEntries: Array.isArray(c.manualEntries) ? c.manualEntries : [],
  };
}
