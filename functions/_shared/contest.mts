/** Shared contest helpers for Netlify Functions. */

import { randomInt } from "crypto";

export type ContestKind = "hosted" | "promo";
/**
 * Gameplay format — each mode has a distinct arena mechanic + visual.
 * Legacy aliases (target/crown/ladder/bounty) migrate on read.
 */
export type ContestMode = "race" | "wheel" | "hotseat" | "deal" | "vault";
export type ContestUnits = "sessions" | "members" | "both";
export type ContestStake = "money" | "bragging";
export type ContestStatus = "scheduled" | "active" | "ended";

export const CONTEST_MODES: ContestMode[] = ["race", "wheel", "hotseat", "deal", "vault"];

/** Map legacy mode strings from older clients / stored records. */
export function migrateContestMode(raw: any): ContestMode {
  const m = String(raw || "").trim();
  // Bounty Board retired in favor of Deal or No Deal case picks.
  if (m === "target" || m === "bounty") return "deal";
  if (m === "crown") return "hotseat";
  if (m === "ladder") return "vault";
  if ((CONTEST_MODES as string[]).includes(m)) return m as ContestMode;
  return "race";
}

/** One wedge on an official wheel spin (frozen at spin time). */
export type ContestWheelSegment = {
  repName: string;
  tickets: number;
  startDeg: number;
  endDeg: number;
  color: string;
};

/** Official wheel outcome — same for every viewer after spin. */
export type ContestWheelSpin = {
  winner: string;
  winnerIndex: number;
  /** Absolute CSS rotation so the pointer lands on the winner wedge. */
  landedDeg: number;
  /** Mid-angle of the winning wedge (0–360, clockwise from top). */
  winnerMidDeg: number;
  segments: ContestWheelSegment[];
  spunAt: string;
  spunBy: string;
};

/** One briefcase in a Deal or No Deal bank (value hidden until assigned). */
export type ContestDealCase = {
  id: string;
  value: number;
};

/** A case awarded for a sale (time order) or coach/admin pick. */
export type ContestDealPick = {
  id: string;
  caseId: string;
  value: number;
  repName: string;
  /** Stable sale id, or `manual:<id>` for coach assigns. */
  saleKey: string;
  source: "sale" | "manual";
  at: string;
  by: string | null;
};

/** Classic-style case ladder — highest opened case wins the prize pot. */
export const DEFAULT_DEAL_CASE_VALUES: number[] = [
  1, 5, 10, 25, 50, 75, 100, 200, 300, 400, 500, 750, 1000, 2500, 5000, 10000,
];

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
  /** Official wheel spin result (integrity: frozen segments + winner). */
  wheelSpin: ContestWheelSpin | null;
  /** Shuffled Deal or No Deal case bank (created once for deal mode). */
  dealCases: ContestDealCase[] | null;
  /** Assigned cases — sale order + coach/admin picks. */
  dealPicks: ContestDealPick[] | null;
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

/**
 * Theme packs drive all cosmetics. Limited packs are what the create UI offers;
 * older theme ids still resolve here for stored contests.
 */
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

/** Theme packs shown in the create/edit UI (cosmetics come from the pack). */
export const CONTEST_THEME_PACKS: ContestTheme[] = [
  "grand-prix",
  "arcade",
  "neon-night",
  "carnival",
  "blood-type-a",
  "dragon-cup",
  "space-race",
  "stadium",
];

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
  const mode = migrateContestMode(body?.mode ?? existing?.mode ?? "race");
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

  // Theme pack owns cosmetics — granular vehicle/track/etc. are no longer
  // independent edit controls. Fall back to existing only if theme has no default.
  const vehicle = pickEnum(
    String(defaults.vehicle ?? existing?.vehicle ?? "car"),
    VEHICLES,
    "car",
  );
  const trackTheme = pickEnum(
    String(defaults.trackTheme ?? existing?.trackTheme ?? "asphalt"),
    TRACKS,
    "asphalt",
  );
  const hypeLevel = pickEnum(
    String(body?.hypeLevel ?? existing?.hypeLevel ?? "hype"),
    HYPES,
    "hype",
  );
  const accent = pickEnum(
    String(defaults.accent ?? existing?.accent ?? "pink"),
    ACCENTS,
    "pink",
  );
  const wheelSkin = pickEnum(
    String(defaults.wheelSkin ?? existing?.wheelSkin ?? "classic"),
    WHEEL_SKINS,
    "classic",
  );
  const effects = pickEnum(
    String(defaults.effects ?? existing?.effects ?? "confetti"),
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

  const mascot = sanitizeMascot(defaults.mascot) || sanitizeMascot(existing?.mascot) || "🏁";

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
        ? migrateContestMode(existing.mode)
        : migrateContestMode(defaults.mode || "race");

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

export function newDealCaseId(): string {
  return "d_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export function newDealPickId(): string {
  return "p_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/** Fisher–Yates shuffle with crypto randomness. */
export function shuffleDealValues(values: number[] = DEFAULT_DEAL_CASE_VALUES): ContestDealCase[] {
  const arr = values.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1);
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr.map((value, i) => ({
    id: `case_${i + 1}_${value}`,
    value,
  }));
}

export function normalizeDealCases(raw: any): ContestDealCase[] | null {
  if (!Array.isArray(raw) || !raw.length) return null;
  const cases = raw
    .map((c: any, i: number) => {
      const value = Number(c?.value);
      if (!Number.isFinite(value) || value < 0) return null;
      const id = String(c?.id || `case_${i + 1}`).trim().slice(0, 40);
      return { id, value: Math.round(value * 100) / 100 } as ContestDealCase;
    })
    .filter(Boolean) as ContestDealCase[];
  return cases.length ? cases : null;
}

export function normalizeDealPicks(raw: any): ContestDealPick[] {
  if (!Array.isArray(raw) || !raw.length) return [];
  return raw
    .map((p: any) => {
      const repName = String(p?.repName || "").trim().slice(0, 80);
      const caseId = String(p?.caseId || "").trim().slice(0, 40);
      const value = Number(p?.value);
      const saleKey = String(p?.saleKey || "").trim().slice(0, 160);
      if (!repName || !caseId || !saleKey || !Number.isFinite(value)) return null;
      const source = p?.source === "manual" ? "manual" : "sale";
      return {
        id: String(p?.id || newDealPickId()).trim().slice(0, 40),
        caseId,
        value: Math.round(value * 100) / 100,
        repName,
        saleKey,
        source,
        at: String(p?.at || new Date().toISOString()),
        by: p?.by ? String(p.by).trim().toLowerCase().slice(0, 120) : null,
      } as ContestDealPick;
    })
    .filter(Boolean) as ContestDealPick[];
}

export type DealSaleInput = {
  saleKey: string;
  repName: string;
  at: string;
};

/**
 * Assign the next unopened cases to new sales in time order.
 * Existing picks (by saleKey) are preserved; case ids already used stay taken.
 */
export function mergeDealPicksFromSales(
  cases: ContestDealCase[],
  existingPicks: ContestDealPick[],
  sales: DealSaleInput[],
): ContestDealPick[] {
  const picks = normalizeDealPicks(existingPicks);
  const usedSaleKeys = new Set(picks.map((p) => p.saleKey));
  const usedCaseIds = new Set(picks.map((p) => p.caseId));
  const freeCases = cases.filter((c) => !usedCaseIds.has(c.id));
  const orderedSales = sales
    .map((s) => ({
      saleKey: String(s.saleKey || "").trim().slice(0, 160),
      repName: String(s.repName || "").trim().slice(0, 80),
      at: String(s.at || "").trim() || new Date().toISOString(),
    }))
    .filter((s) => s.saleKey && s.repName && !usedSaleKeys.has(s.saleKey))
    .sort((a, b) => a.at.localeCompare(b.at) || a.saleKey.localeCompare(b.saleKey));

  let freeIdx = 0;
  for (const sale of orderedSales) {
    if (freeIdx >= freeCases.length) break;
    const nextCase = freeCases[freeIdx++];
    picks.push({
      id: newDealPickId(),
      caseId: nextCase.id,
      value: nextCase.value,
      repName: sale.repName,
      saleKey: sale.saleKey,
      source: "sale",
      at: sale.at,
      by: null,
    });
  }
  return picks;
}

/** Coach/admin assigns the next free case to a teammate. */
export function assignManualDealPick(
  cases: ContestDealCase[],
  existingPicks: ContestDealPick[],
  repName: string,
  by: string,
  nowIso = new Date().toISOString(),
): { picks: ContestDealPick[]; pick: ContestDealPick | null; error?: string } {
  const name = String(repName || "").trim().slice(0, 80);
  if (!name) return { picks: existingPicks, pick: null, error: "Pick a teammate" };
  const picks = normalizeDealPicks(existingPicks);
  const usedCaseIds = new Set(picks.map((p) => p.caseId));
  const nextCase = cases.find((c) => !usedCaseIds.has(c.id));
  if (!nextCase) return { picks, pick: null, error: "No cases left in the bank" };
  const pick: ContestDealPick = {
    id: newDealPickId(),
    caseId: nextCase.id,
    value: nextCase.value,
    repName: name,
    saleKey: `manual:${nowIso}:${name}`,
    source: "manual",
    at: nowIso,
    by: String(by || "").trim().toLowerCase().slice(0, 120) || null,
  };
  return { picks: picks.concat([pick]), pick };
}

const WHEEL_COLORS = [
  "#f472b6", "#a855f7", "#38bdf8", "#fbbf24", "#34d399",
  "#fb7185", "#818cf8", "#22d3ee", "#f59e0b", "#4ade80",
  "#e879f9", "#60a5fa", "#f97316", "#2dd4bf", "#ef4444",
];

/** Normalize ticket entries from the client for an official spin. */
export function normalizeWheelEntries(raw: any): { repName: string; tickets: number }[] {
  if (!Array.isArray(raw)) return [];
  const map = new Map<string, number>();
  for (const row of raw) {
    const repName = String(row?.repName || "").trim().slice(0, 80);
    if (!repName) continue;
    const t = Number(row?.tickets);
    const tickets = Number.isFinite(t) && t > 0 ? Math.round(t * 100) / 100 : 0;
    if (tickets <= 0) continue;
    map.set(repName, (map.get(repName) || 0) + tickets);
  }
  return Array.from(map.entries())
    .map(([repName, tickets]) => ({ repName, tickets }))
    .sort((a, b) => b.tickets - a.tickets || a.repName.localeCompare(b.repName))
    .slice(0, 40);
}

/**
 * Build proportional wedges + pick a winner with crypto randomness.
 * Pointer sits at the top (0°). Wheel rotates clockwise by landedDeg so the
 * winning wedge's midpoint ends under the pointer.
 */
export function createOfficialWheelSpin(
  entries: { repName: string; tickets: number }[],
  spunBy: string,
  nowIso = new Date().toISOString(),
): ContestWheelSpin | null {
  const cleaned = normalizeWheelEntries(entries);
  if (!cleaned.length) return null;

  const total = cleaned.reduce((s, e) => s + e.tickets, 0);
  if (!(total > 0)) return null;

  const segments: ContestWheelSegment[] = [];
  let cursor = 0;
  cleaned.forEach((e, i) => {
    const sweep = (e.tickets / total) * 360;
    const startDeg = cursor;
    const endDeg = i === cleaned.length - 1 ? 360 : cursor + sweep;
    segments.push({
      repName: e.repName,
      tickets: e.tickets,
      startDeg,
      endDeg,
      color: WHEEL_COLORS[i % WHEEL_COLORS.length],
    });
    cursor = endDeg;
  });

  // Weighted pick by ticket mass (integer millitickets for crypto.randomInt).
  const weights = cleaned.map((e) => Math.max(1, Math.round(e.tickets * 1000)));
  const weightTotal = weights.reduce((s, w) => s + w, 0);
  const pick = randomInt(0, weightTotal);
  let acc = 0;
  let winnerIndex = 0;
  for (let i = 0; i < weights.length; i++) {
    acc += weights[i];
    if (pick < acc) { winnerIndex = i; break; }
  }

  const winnerSeg = segments[winnerIndex];
  const winnerMidDeg = (winnerSeg.startDeg + winnerSeg.endDeg) / 2;
  // Extra full turns for drama, then align midpoint under the top pointer.
  const turns = 5;
  const landedDeg = turns * 360 + ((360 - winnerMidDeg) % 360);

  return {
    winner: winnerSeg.repName,
    winnerIndex,
    landedDeg,
    winnerMidDeg,
    segments,
    spunAt: nowIso,
    spunBy: String(spunBy || "").trim().toLowerCase().slice(0, 120),
  };
}

export function normalizeWheelSpin(raw: any): ContestWheelSpin | null {
  if (!raw || typeof raw !== "object") return null;
  const winner = String(raw.winner || "").trim().slice(0, 80);
  if (!winner) return null;
  const segments = Array.isArray(raw.segments)
    ? raw.segments.map((s: any, i: number) => {
      const repName = String(s?.repName || "").trim().slice(0, 80);
      if (!repName) return null;
      const startDeg = Number(s?.startDeg);
      const endDeg = Number(s?.endDeg);
      const tickets = Number(s?.tickets);
      return {
        repName,
        tickets: Number.isFinite(tickets) ? tickets : 0,
        startDeg: Number.isFinite(startDeg) ? startDeg : 0,
        endDeg: Number.isFinite(endDeg) ? endDeg : 0,
        color: String(s?.color || WHEEL_COLORS[i % WHEEL_COLORS.length]).slice(0, 32),
      } as ContestWheelSegment;
    }).filter(Boolean) as ContestWheelSegment[]
    : [];
  if (!segments.length) return null;
  const landedDeg = Number(raw.landedDeg);
  const winnerMidDeg = Number(raw.winnerMidDeg);
  const winnerIndex = Number(raw.winnerIndex);
  return {
    winner,
    winnerIndex: Number.isFinite(winnerIndex) ? winnerIndex : 0,
    landedDeg: Number.isFinite(landedDeg) ? landedDeg : 0,
    winnerMidDeg: Number.isFinite(winnerMidDeg) ? winnerMidDeg : 0,
    segments,
    spunAt: String(raw.spunAt || new Date().toISOString()),
    spunBy: String(raw.spunBy || "").trim().toLowerCase().slice(0, 120),
  };
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
    mode: migrateContestMode(c.mode),
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
    wheelSpin: normalizeWheelSpin(c.wheelSpin),
    dealCases: normalizeDealCases(c.dealCases),
    dealPicks: normalizeDealPicks(c.dealPicks),
    finalStandings: Array.isArray(c.finalStandings) ? c.finalStandings : null,
    manualEntries: Array.isArray(c.manualEntries) ? c.manualEntries : [],
  };
}
