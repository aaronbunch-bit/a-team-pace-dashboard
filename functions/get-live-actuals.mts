import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { requireSignedIn } from "./_shared/identity.mts";
import { runSupabaseSql, supabaseConfig } from "./_shared/supabase.mts";
import { FALLBACK_ROSTER_EMAILS } from "./_shared/roster.mts";
import {
  LIVE_ACTUALS_CACHE_KEY,
  loadLedgerExclusionIds,
} from "./_shared/ledger-exclusions.mts";
import { TEAM_TIME_ZONE, clampAsOfToTeamToday, teamTodayYmd } from "./_shared/time.mts";

/** Shared warm cache so N open tabs don't each hit Supabase every poll. */
const LIVE_CACHE_TTL_MS = 60_000;
const LIVE_CACHE_KEY = LIVE_ACTUALS_CACHE_KEY;

/**
 * Counting rule the tiles were built with, shown on the Cancels panel.
 *
 * Four rewrites in a row all read the same -86.5 on screen, and there was no way
 * to tell a rule that had not worked from a build that had not shipped yet.
 */
const LEDGER_RULE_VERSION = "created_at+scoring+lifetime-v1";

type LedgerRow = {
  email: string;
  manager_name: string;
  client_id: string;
  attribution_date: string;
  occurred_at: string;
  members: number;
  sessions: number;
  ledger_id?: string;
  attribution_id?: string;
  manager_id?: string;
  ledger_created_at?: string;
  /** When the original sale happened — audit only, never the month key. */
  sale_occurred_at?: string;
  /** Upstream soft-deleted the attribution this line hangs off. */
  attribution_deleted?: boolean;
  /**
   * Every line this attribution + manager has ever had, summed — including the
   * months outside this window. A journal can't legitimately net below zero, so
   * this is what tells a real cancel apart from a period-transfer duplicate.
   */
  lifetime_members?: number;
  lifetime_sessions?: number;
  /** Journal role, assigned by netLedgerJournal. */
  kind?: LedgerKind;
};

/**
 * What a ledger line means inside its attribution's journal.
 *
 * - `credit`   — positive line (a sale, or the corrected value after a reversal)
 * - `reversal` — negative line that a later positive line in the same
 *                attribution replaces (the 100%-corrected-to-50% shape)
 * - `cancel`   — negative line with nothing after it: real lost business
 */
type LedgerKind = "credit" | "reversal" | "cancel";

/** A ledger row the pacer removed before totalling, and why. */
type SuppressedRow = {
  ledgerId: string;
  attributionId: string;
  clientId: string;
  repName: string;
  members: number;
  sessions: number;
  date: string;
  reason: "admin-excluded" | "duplicate-period-line";
};

/**
 * An attribution whose journal has more than one line, with the net the pacer
 * actually counted. Replaces the old "superseded revision" suppression: the
 * ledger is a journal, so every line is summed rather than one winning.
 */
type NettedAttribution = {
  attributionId: string;
  clientId: string;
  repName: string;
  ledgerIds: string[];
  members: number[];
  sessions: number[];
  kinds: LedgerKind[];
  dates: string[];
  netMembers: number;
  netSessions: number;
};

/** Same client + rep credited by two separate attributions — needs a human. */
type FlaggedPair = {
  clientId: string;
  repName: string;
  ledgerIds: string[];
  attributionIds: string[];
  members: number[];
  sessions: number[];
  dates: string[];
};

type PerRep = {
  members: number;
  sessions: number;
  membersCancels: number;
  sessionsCancels: number;
  items: {
    clientId: string;
    members: number;
    sessions: number;
    date: string;
    occurredAt?: string;
    /** Stable ledger row id when available (Deal or No Deal sale keys). */
    ledgerId?: string;
    attributionId?: string;
    kind?: LedgerKind;
    /** Original sale timestamp when the line is a later adjustment. */
    saleOccurredAt?: string;
  }[];
};

type LiveCacheDoc = {
  fetchedAtMs: number;
  payload: Record<string, unknown>;
};

function safeEmail(email: string): string | null {
  const e = String(email || "").trim().toLowerCase();
  if (!e || e.length > 120) return null;
  if (!/^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/i.test(e)) return null;
  return e;
}

async function loadEmailToDisplay(): Promise<Record<string, string>> {
  const map: Record<string, string> = { ...FALLBACK_ROSTER_EMAILS };
  try {
    const goals = await getStore("goals").get("current", { type: "json" });
    if (goals && typeof goals === "object") {
      for (const [display, g] of Object.entries(goals as Record<string, any>)) {
        const email = safeEmail(g?.email);
        if (email) map[email] = String(display).trim();
      }
    }
  } catch {
    // Keep fallbacks.
  }
  return map;
}

function sqlStringList(values: string[]): string {
  return values.map((v) => `'${v.replace(/'/g, "''")}'`).join(", ");
}

/**
 * Does a ledger line belong in this month's MTD?
 *
 * The export's `attribution_date` is the ledger row's created_at. Cancels of
 * older sales still land in the month they hit — but only sales from this month
 * or the one before still score. Without that gate, July MTD also pulled
 * cancels of much older sales and the tiles read -86.5 against the export's
 * -50.5. Keying on attributions.occurred_at alone is the opposite mistake: it
 * only finds cancels of *this* month's sales (-14).
 *
 * Pure predicate so the unit tests lock the same rule the SQL uses.
 */
export function lineInLiveMonth(
  { lineMonth, saleMonth }: { lineMonth: string; saleMonth: string },
  month: string,
  priorMonth: string
): boolean {
  if (lineMonth !== month) return false;
  return saleMonth === month || saleMonth === priorMonth;
}

/** Float slack — ledger amounts are halves and quarters, never this small. */
const EPSILON = 1e-9;

function rowSortKey(row: LedgerRow): string {
  // created_at orders the journal; ledger id breaks exact ties.
  return `${String(row.ledger_created_at || "")}|${String(row.ledger_id || "")}`;
}

/**
 * Net each attribution's ledger journal.
 *
 * The ledger is a journal, not a snapshot: a correction is written as a
 * reversal line plus a replacement line, and a cancellation is written as a
 * reversal line with nothing after it. Summing every line is therefore the only
 * rule that is right in all shapes:
 *
 *   sale then correction   (+1, -1, +0.5) -> +0.5
 *   sale then cancellation (+1, -1)       ->  0
 *   two credits, one pulled (+1, +1, -1)  -> +1
 *
 * Keeping only the newest line instead returns -1, -1 and -1 for those three —
 * which understated pace and inflated cancels.
 *
 * Lines are classified so cancel reporting stays honest: a negative line that a
 * later positive line replaces is a `reversal` (bookkeeping), while a negative
 * line with nothing after it is a real `cancel`.
 *
 * Two *different* attributions for the same client are still only flagged, never
 * merged: that shape is also a legitimate second purchase or a cancel/rebook
 * pair. Admins can exclude a specific ledger id.
 */
export function netLedgerJournal(
  rows: LedgerRow[],
  emailToDisplay: Record<string, string>,
  exclusions: Set<string>
): {
  rows: LedgerRow[];
  suppressed: SuppressedRow[];
  flagged: FlaggedPair[];
  netted: NettedAttribution[];
  duplicateRows: number;
} {
  const suppressed: SuppressedRow[] = [];
  const displayFor = (row: LedgerRow) => {
    const email = safeEmail(row.email);
    return (email && emailToDisplay[email]) || String(row.manager_name || "Unknown rep");
  };

  // One row per ledger id. A rep with two live flex_team_members records fans
  // the join out and the same ledger line arrives twice, which silently doubles
  // that rep's cancels.
  const seenLedgerIds = new Set<string>();
  const deduped: LedgerRow[] = [];
  let duplicateRows = 0;
  for (const row of rows) {
    const ledgerId = String(row.ledger_id || "").trim();
    if (ledgerId) {
      const key = `${ledgerId}|${String(row.manager_id || "").trim()}`;
      if (seenLedgerIds.has(key)) {
        duplicateRows++;
        continue;
      }
      seenLedgerIds.add(key);
    }
    deduped.push(row);
  }

  const afterExclusions: LedgerRow[] = [];
  for (const row of deduped) {
    const ledgerId = String(row.ledger_id || "").trim();
    if (ledgerId && exclusions.has(ledgerId)) {
      suppressed.push({
        ledgerId,
        attributionId: String(row.attribution_id || ""),
        clientId: String(row.client_id || ""),
        repName: displayFor(row),
        members: Number(row.members) || 0,
        sessions: Number(row.sessions) || 0,
        date: String(row.attribution_date || "").slice(0, 10),
        reason: "admin-excluded",
      });
      continue;
    }
    afterExclusions.push(row);
  }

  // Group each attribution's journal — keyed on attribution + manager so a
  // split sale stays two independent journals.
  const byAttribution = new Map<string, LedgerRow[]>();
  const unkeyed: LedgerRow[] = [];
  for (const row of afterExclusions) {
    const attributionId = String(row.attribution_id || "").trim();
    const managerId = String(row.manager_id || "").trim();
    if (!attributionId) {
      unkeyed.push(row);
      continue;
    }
    const key = `${attributionId}|${managerId}`;
    const bucket = byAttribution.get(key);
    if (bucket) bucket.push(row);
    else byAttribution.set(key, [row]);
  }

  const kept: LedgerRow[] = [];
  const netted: NettedAttribution[] = [];
  for (const row of unkeyed) {
    const isNegative = (Number(row.members) || 0) < 0 || (Number(row.sessions) || 0) < 0;
    kept.push({ ...row, kind: isNegative ? "cancel" : "credit" });
  }

  for (const bucket of byAttribution.values()) {
    const ordered = [...bucket].sort((a, b) => rowSortKey(a).localeCompare(rowSortKey(b)));
    const classified = ordered.map((row, index) => {
      const negative = (Number(row.members) || 0) < 0 || (Number(row.sessions) || 0) < 0;
      if (!negative) return { ...row, kind: "credit" as LedgerKind };
      const replacedLater = ordered
        .slice(index + 1)
        .some((later) => (Number(later.members) || 0) > 0 || (Number(later.sessions) || 0) > 0);
      return { ...row, kind: (replacedLater ? "reversal" : "cancel") as LedgerKind };
    });

    // One credit row per attribution. Credits and the reversals that revise
    // them are folded into a single line carrying the corrected value, so a
    // client whose attribution went 100% -> 50% is listed once at 50% instead
    // of showing both. Cancels stay as their own rows: they happen on their own
    // date and Ops reviews them individually.
    const creditLines = classified.filter((r) => r.kind !== "cancel");
    let cancelLines = classified.filter((r) => r.kind === "cancel");

    // Drop period-transfer duplicates.
    //
    // Cancelling a prior-month sale takes two lines: one unwinding the credit in
    // the month it was booked, one charging the month the cancel landed in. Both
    // are written now, so a window on write time sees both and the rep is
    // charged twice — the July tiles read -86.5 against an export's -50.5, and
    // the gap was exactly the prior-month cancels, counted a second time.
    //
    // The tell is arithmetic, not a date: summed over all time an attribution
    // cannot lose more than it was ever credited. Across 5,956 complete journals
    // in the July export, not one nets below zero. So when lifetime totals go
    // negative, that overshoot is bookkeeping, and the cancel lines that fit
    // inside it are dropped oldest-first — never more than the overshoot, so a
    // genuine cancel of a prior-month sale (lifetime nets to zero) is untouched.
    const lifetimeMembers = Number(classified[0].lifetime_members);
    const lifetimeSessions = Number(classified[0].lifetime_sessions);
    let overMembers = Number.isFinite(lifetimeMembers) ? Math.max(0, -lifetimeMembers) : 0;
    let overSessions = Number.isFinite(lifetimeSessions) ? Math.max(0, -lifetimeSessions) : 0;
    if (cancelLines.length > 1 && (overMembers > EPSILON || overSessions > EPSILON)) {
      const surviving: LedgerRow[] = [];
      for (const row of cancelLines) {
        const lostMembers = -(Number(row.members) || 0);
        const lostSessions = -(Number(row.sessions) || 0);
        const fits =
          lostMembers <= overMembers + EPSILON &&
          lostSessions <= overSessions + EPSILON &&
          (lostMembers > EPSILON || lostSessions > EPSILON);
        if (fits) {
          overMembers -= lostMembers;
          overSessions -= lostSessions;
          suppressed.push({
            ledgerId: String(row.ledger_id || ""),
            attributionId: String(row.attribution_id || ""),
            clientId: String(row.client_id || ""),
            repName: displayFor(row),
            members: Number(row.members) || 0,
            sessions: Number(row.sessions) || 0,
            date: String(row.attribution_date || "").slice(0, 10),
            reason: "duplicate-period-line",
          });
          continue;
        }
        surviving.push(row);
      }
      cancelLines = surviving;
    }
    if (creditLines.length) {
      const netMembers = creditLines.reduce((sum, r) => sum + (Number(r.members) || 0), 0);
      const netSessions = creditLines.reduce((sum, r) => sum + (Number(r.sessions) || 0), 0);
      if (netMembers !== 0 || netSessions !== 0) {
        // Earliest line dates the credit (the sale), newest supplies the row id
        // so sale keys follow the surviving revision.
        const newest = creditLines[creditLines.length - 1];
        kept.push({
          ...creditLines[0],
          members: netMembers,
          sessions: netSessions,
          ledger_id: newest.ledger_id,
          ledger_created_at: newest.ledger_created_at,
          kind: "credit",
        });
      }
    }
    kept.push(...cancelLines);

    if (classified.length > 1 && (creditLines.length || cancelLines.length)) {
      netted.push({
        attributionId: String(classified[0].attribution_id || ""),
        clientId: String(classified[0].client_id || ""),
        repName: displayFor(classified[0]),
        ledgerIds: classified.map((r) => String(r.ledger_id || "")),
        members: classified.map((r) => Number(r.members) || 0),
        sessions: classified.map((r) => Number(r.sessions) || 0),
        kinds: classified.map((r) => r.kind as LedgerKind),
        dates: classified.map((r) => String(r.attribution_date || "").slice(0, 10)),
        netMembers: classified.reduce((sum, r) => sum + (Number(r.members) || 0), 0),
        netSessions: classified.reduce((sum, r) => sum + (Number(r.sessions) || 0), 0),
      });
    }
  }

  // Flag-only pass: same client + rep credited through separate attributions
  // that each still net positive.
  const netByClientRepAttribution = new Map<string, LedgerRow[]>();
  for (const row of kept) {
    const clientId = String(row.client_id || "").trim();
    if (!clientId) continue;
    const key = `${clientId}|${displayFor(row)}|${String(row.attribution_id || "")}`;
    const bucket = netByClientRepAttribution.get(key);
    if (bucket) bucket.push(row);
    else netByClientRepAttribution.set(key, [row]);
  }
  const positiveByClientRep = new Map<string, LedgerRow[]>();
  for (const bucket of netByClientRepAttribution.values()) {
    const netMembers = bucket.reduce((sum, r) => sum + (Number(r.members) || 0), 0);
    const netSessions = bucket.reduce((sum, r) => sum + (Number(r.sessions) || 0), 0);
    if (netMembers <= 0 && netSessions <= 0) continue;
    const key = `${String(bucket[0].client_id || "")}|${displayFor(bucket[0])}`;
    const existing = positiveByClientRep.get(key);
    // One representative row per attribution — the newest line in its journal.
    const representative = [...bucket].sort((a, b) => rowSortKey(a).localeCompare(rowSortKey(b))).pop()!;
    if (existing) existing.push(representative);
    else positiveByClientRep.set(key, [representative]);
  }
  const flagged: FlaggedPair[] = [];
  for (const bucket of positiveByClientRep.values()) {
    if (bucket.length < 2) continue;
    const ordered = [...bucket].sort((a, b) => rowSortKey(a).localeCompare(rowSortKey(b)));
    flagged.push({
      clientId: String(ordered[0].client_id || ""),
      repName: displayFor(ordered[0]),
      ledgerIds: ordered.map((r) => String(r.ledger_id || "")),
      attributionIds: ordered.map((r) => String(r.attribution_id || "")),
      members: ordered.map((r) => Number(r.members) || 0),
      sessions: ordered.map((r) => Number(r.sessions) || 0),
      dates: ordered.map((r) => String(r.attribution_date || "").slice(0, 10)),
    });
  }

  return { rows: kept, suppressed, flagged, netted, duplicateRows };
}

/**
 * Every negative line behind the cancel tiles, itemised.
 *
 * The tiles used to be a server-side sum the browser could not check, so when
 * they read -86.5 against an export's -50.5 there was no way to see which lines
 * were counted. Shipping the lines themselves — they are tens of rows, not
 * thousands — lets the browser total them and lets a human read them.
 */
export function cancelLineItems(
  rows: LedgerRow[],
  emailToDisplay: Record<string, string>
) {
  return rows
    .filter((row) => row.kind === "cancel")
    .map((row) => {
      const email = safeEmail(row.email);
      return {
        rep: (email && emailToDisplay[email]) || String(row.manager_name || "Unknown rep"),
        clientId: String(row.client_id || "").trim(),
        date: String(row.attribution_date || "").slice(0, 10),
        members: Math.min(Number(row.members) || 0, 0),
        sessions: Math.min(Number(row.sessions) || 0, 0),
        saleMonth: String(row.sale_occurred_at || "").slice(0, 7),
        ledgerId: String(row.ledger_id || "").trim(),
      };
    })
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""));
}

type RowSummary = { rows: number; members: number; sessions: number };

function summarizeRows(rows: LedgerRow[]): RowSummary {
  return {
    rows: rows.length,
    members: rows.reduce((sum, r) => sum + (Number(r.members) || 0), 0),
    sessions: rows.reduce((sum, r) => sum + (Number(r.sessions) || 0), 0),
  };
}

/** Previous calendar month for a `YYYY-MM` key. */
function priorMonthKey(month: string): string {
  const [y, m] = month.split("-").map((n) => Number(n));
  if (!y || !m) return "";
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

/**
 * Cancels split by how old the sale behind them is. The export's July cancels
 * are -14.0/-108 against July sales and -36.5/-228 against June sales, so this
 * is the one breakdown that says at a glance whether the month window is
 * reading the same population the reps reconcile against.
 */
function summarizeCancelsBySaleMonth(rows: LedgerRow[], month: string) {
  const prior = priorMonthKey(month);
  const cancels = rows.filter((r) => r.kind === "cancel");
  const bucketOf = (row: LedgerRow) => {
    const saleMonth = String(row.sale_occurred_at || "").slice(0, 7);
    if (saleMonth === month) return "thisMonthSale" as const;
    if (saleMonth && saleMonth === prior) return "priorMonthSale" as const;
    return "olderSale" as const;
  };
  return {
    thisMonthSale: summarizeRows(cancels.filter((r) => bucketOf(r) === "thisMonthSale")),
    priorMonthSale: summarizeRows(cancels.filter((r) => bucketOf(r) === "priorMonthSale")),
    olderSale: summarizeRows(cancels.filter((r) => bucketOf(r) === "olderSale")),
  };
}

function buildActuals(
  rows: LedgerRow[],
  emailToDisplay: Record<string, string>
): { asOf: string; perRep: Record<string, PerRep>; matchedRows: number; unmatchedManagers: string[] } {
  const perRep: Record<string, PerRep> = {};
  for (const display of new Set(Object.values(emailToDisplay))) {
    perRep[display] = {
      members: 0,
      sessions: 0,
      membersCancels: 0,
      sessionsCancels: 0,
      items: [],
    };
  }

  let maxDate: string | null = null;
  let matchedRows = 0;
  const unmatched = new Set<string>();

  for (const row of rows) {
    const email = safeEmail(row.email);
    const display = email ? emailToDisplay[email] : null;
    const d = String(row.attribution_date || "").slice(0, 10);
    if (d && (!maxDate || d > maxDate)) maxDate = d;
    if (!display) {
      if (row.manager_name) unmatched.add(String(row.manager_name));
      continue;
    }
    matchedRows++;
    const m = Number(row.members) || 0;
    const s = Number(row.sessions) || 0;
    const bucket = perRep[display];
    bucket.members += m;
    bucket.sessions += s;
    // Only cancels are lost business. Revisions were already folded into the
    // attribution's single credit row, so nothing here double-reports a
    // correction as attrition.
    if (row.kind === "cancel") {
      if (m < 0) bucket.membersCancels += m;
      if (s < 0) bucket.sessionsCancels += s;
    }
    const occurredAt = String(row.occurred_at || "").trim();
    const ledgerId = String(row.ledger_id || "").trim();
    const attributionId = String(row.attribution_id || "").trim();
    const saleOccurredAt = String(row.sale_occurred_at || "").trim();
    bucket.items.push({
      clientId: String(row.client_id || "").trim(),
      members: m,
      sessions: s,
      date: d,
      ...(occurredAt ? { occurredAt } : {}),
      ...(ledgerId ? { ledgerId } : {}),
      ...(attributionId ? { attributionId } : {}),
      ...(row.kind ? { kind: row.kind } : {}),
      ...(saleOccurredAt && saleOccurredAt !== occurredAt ? { saleOccurredAt } : {}),
    });
  }

  return {
    // Never let as-of run ahead of Central Time "today" (UTC midnight is still
    // evening prior day in America/Chicago).
    asOf: clampAsOfToTeamToday(maxDate || teamTodayYmd()),
    perRep,
    matchedRows,
    unmatchedManagers: [...unmatched].sort(),
  };
}

async function maybeFreezePrelimAndCache(actuals: { asOf: string; perRep: Record<string, PerRep> }) {
  const actualsStore = getStore("actuals");
  const prelimStore = getStore("prelim-snapshots");
  const existing = (await actualsStore.get("current", { type: "json" })) || null;
  const oldMonth = existing && existing.asOf ? String(existing.asOf).slice(0, 7) : "";
  const newMonth = String(actuals.asOf || "").slice(0, 7);

  let prelim: any = null;
  let prelimChanged = false;
  if (oldMonth && newMonth && oldMonth !== newMonth && existing?.perRep) {
    prelim = (await prelimStore.get("current", { type: "json" })) || {};
    let goals: any = null;
    try {
      goals = await getStore("goals").get("current", { type: "json" });
    } catch {
      goals = null;
    }
    prelim[oldMonth] = {
      asOf: existing.asOf,
      perRep: existing.perRep,
      goals: goals || {},
      computedAt: new Date().toISOString(),
      source: "supabase-live-rollover",
    };
    await prelimStore.setJSON("current", prelim);
    prelimChanged = true;
  }

  // Keep Blobs actuals fresh as a fallback when Supabase is unreachable.
  // Skip the write when nothing meaningful changed so N open browsers don't
  // stampede Blobs on every poll.
  //
  // Cancels are part of "meaningful": they used to be left out, so a month whose
  // sales had not moved kept serving an old cancel total to every browser that
  // fell back to Blobs — a stale number that survived any number of fixes.
  const digest = (doc: any) => {
    const per = (doc && doc.perRep) || {};
    return `${doc?.asOf || ""}|` + Object.keys(per).sort().map((k) => {
      const r = per[k] || {};
      return `${k}:${Number(r.members) || 0}:${Number(r.sessions) || 0}` +
        `:${Number(r.membersCancels) || 0}:${Number(r.sessionsCancels) || 0}` +
        `:${Array.isArray(r.items) ? r.items.length : 0}`;
    }).join(",");
  };
  if (digest(existing) !== digest(actuals)) {
    await actualsStore.setJSON("current", actuals);
  }
  // Only load/return prelim when the month rolled — poll payloads stay smaller.
  if (!prelimChanged) return null;
  return prelim || {};
}

function stripItemsForCompact(actuals: { asOf: string; perRep: Record<string, PerRep> }) {
  const perRep: Record<string, Omit<PerRep, "items"> & { items?: never }> = {};
  for (const [name, row] of Object.entries(actuals.perRep || {})) {
    perRep[name] = {
      members: row.members,
      sessions: row.sessions,
      membersCancels: row.membersCancels,
      sessionsCancels: row.sessionsCancels,
    };
  }
  return { asOf: actuals.asOf, perRep };
}

/**
 * Compact polling payloads keep only the integrity counts — enough to badge the
 * Ops tab without shipping the full row detail on every poll.
 */
/**
 * ETag for a live payload.
 *
 * Shape is part of the identity, not just the numbers: a compact poll and a full
 * one carry the same totals but different bodies, so without the prefix a client
 * holding the compact tag would get a 304 for a request that needed the line
 * items and would render an empty Cancels list.
 */
export function livePayloadEtag(payload: Record<string, unknown>, compact: boolean): string {
  const actuals = payload.actuals as { asOf?: string; perRep?: Record<string, any> } | undefined;
  const per = (actuals && actuals.perRep) || {};
  const body = Object.keys(per).sort().map((k) => {
    const r = per[k] || {};
    return `${k}:${Number(r.members) || 0}:${Number(r.sessions) || 0}:${Number(r.membersCancels) || 0}:${Number(r.sessionsCancels) || 0}`;
  }).join(",");
  const cancels = Array.isArray(payload.cancelItems) ? payload.cancelItems.length : 0;
  return `"${compact ? "c" : "f"}|${actuals?.asOf || ""}|${cancels}|${body}"`;
}

function liveJsonResponse(payload: Record<string, unknown>, etag: string) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "private, max-age=30",
      ETag: etag,
      Vary: "Authorization",
    },
  });
}

function stripIntegrityForCompact(payload: Record<string, unknown>) {
  const integrity = payload.ledgerIntegrity as
    | { suppressed?: unknown[]; flagged?: unknown[]; netted?: unknown[]; window?: unknown }
    | undefined;
  if (!integrity) return;
  payload.ledgerIntegrity = {
    suppressedCount: Array.isArray(integrity.suppressed) ? integrity.suppressed.length : 0,
    flaggedCount: Array.isArray(integrity.flagged) ? integrity.flagged.length : 0,
    nettedCount: Array.isArray(integrity.netted) ? integrity.netted.length : 0,
    // A handful of numbers — small enough to keep on every poll, and the fastest
    // way to see the window the tiles were built from.
    window: integrity.window,
    compact: true,
  };
}

export default async (req: Request, context: Context) => {
  if (req.method !== "GET") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
  }

  const auth = await requireSignedIn(req, context);
  if (auth.response) return auth.response;

  if (!supabaseConfig()) {
    return new Response(
      JSON.stringify({
        error: "Supabase not configured",
        hint: "Set SUPABASE_ACCESS_TOKEN (and optional SUPABASE_PROJECT_REF) in Netlify env",
      }),
      { status: 503, headers: { "Content-Type": "application/json" } }
    );
  }

  const url = new URL(req.url);
  const compact = url.searchParams.get("compact") === "1";
  const bypassCache = url.searchParams.get("fresh") === "1";
  const ifNoneMatch = String(req.headers.get("if-none-match") || "").trim();

  const finish = (payload: Record<string, unknown>) => {
    const out = { ...payload };
    if (compact && out.actuals) {
      out.actuals = stripItemsForCompact(out.actuals as any);
      delete out.prelim;
      stripIntegrityForCompact(out);
    }
    const etag = livePayloadEtag(out, compact);
    if (ifNoneMatch && ifNoneMatch === etag) {
      return new Response(null, {
        status: 304,
        headers: {
          ETag: etag,
          "Cache-Control": "private, max-age=30",
          Vary: "Authorization",
        },
      });
    }
    return liveJsonResponse(out, etag);
  };

  try {
    const cacheStore = getStore("actuals");
    if (!bypassCache) {
      try {
        const cached = (await cacheStore.get(LIVE_CACHE_KEY, { type: "json" })) as LiveCacheDoc | null;
        if (cached?.payload && Number(cached.fetchedAtMs) > 0) {
          const age = Date.now() - Number(cached.fetchedAtMs);
          if (age >= 0 && age < LIVE_CACHE_TTL_MS) {
            return finish({ ...cached.payload, cacheHit: true, cacheAgeMs: age });
          }
        }
      } catch {
        // Fall through to live query.
      }
    }

    const emailToDisplay = await loadEmailToDisplay();
    const emails = Object.keys(emailToDisplay);
    if (!emails.length) {
      return new Response(JSON.stringify({ error: "No roster emails configured" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Current calendar month in America/Chicago (CST/CDT) — team business day.
    //
    // Two conditions, matching the July rep-scores export (-50.5 / -336 cancels)
    // and the manual pacer's refunds (51.5 / 326):
    //
    // 1. Month key is l.created_at — the export's attribution_date. A cancel of a
    //    June sale written in July belongs to July.
    // 2. The sale (a.occurred_at) is still in scoring range: this month or the
    //    one before. Without (2), July also charges cancels of much older sales
    //    and the tiles overshoot to -86.5. Without (1), keying on occurred_at
    //    alone only finds cancels of *this* month's sales (-14).
    //
    // Soft-deleted attributions stay in: cancelled rows are often soft-deleted
    // upstream while their negative ledger lines (and the export) remain live.
    const tz = TEAM_TIME_ZONE.replace(/'/g, "''");
    const monthYmd = teamTodayYmd().slice(0, 7);
    const sql = `
with bounds as (
  select
    (date_trunc('month', (now() at time zone '${tz}')) at time zone '${tz}') as month_start,
    ((date_trunc('month', (now() at time zone '${tz}')) + interval '1 month') at time zone '${tz}') as month_end,
    ((date_trunc('month', (now() at time zone '${tz}')) - interval '1 month') at time zone '${tz}') as scoring_start
),
win as (
  select
    l.id as ledger_id,
    l.attribution_id,
    l.manager_id,
    l.created_at,
    l.net_client_credit_amount,
    l.hours_amount,
    a.client_id,
    a.occurred_at as sale_occurred_at,
    (a.deleted_at is not null) as attribution_deleted,
    lower(f.email) as email,
    f.name as manager_name
  from sales_attribution.rep_scores_ledger_entries l
  join sales_attribution.attributions a
    on a.id = l.attribution_id
  join sales_attribution.flex_team_members f
    on f.manager_id = l.manager_id
   and f.deleted_at is null
  cross join bounds b
  where l.deleted_at is null
    and l.created_at >= b.month_start
    and l.created_at <  b.month_end
    and a.occurred_at >= b.scoring_start
    and a.occurred_at <  b.month_end
    and lower(f.email) in (${sqlStringList(emails)})
),
journals as (
  select distinct attribution_id, manager_id from win
),
life as (
  select
    l2.attribution_id,
    l2.manager_id,
    sum(l2.net_client_credit_amount)::float8 as lifetime_members,
    sum(l2.hours_amount)::float8 as lifetime_sessions
  from sales_attribution.rep_scores_ledger_entries l2
  join journals j
    on j.attribution_id = l2.attribution_id
   and j.manager_id = l2.manager_id
  where l2.deleted_at is null
  group by 1, 2
)
select
  win.email,
  win.manager_name,
  win.client_id,
  win.ledger_id::text as ledger_id,
  win.attribution_id::text as attribution_id,
  win.manager_id::text as manager_id,
  win.created_at::text as ledger_created_at,
  (win.created_at at time zone '${tz}')::date::text as attribution_date,
  (win.created_at at time zone '${tz}')::text as occurred_at,
  (win.sale_occurred_at at time zone '${tz}')::text as sale_occurred_at,
  win.attribution_deleted,
  win.net_client_credit_amount::float8 as members,
  win.hours_amount::float8 as sessions,
  life.lifetime_members,
  life.lifetime_sessions
from win
join life
  on life.attribution_id = win.attribution_id
 and life.manager_id = win.manager_id
order by win.created_at asc, win.ledger_id asc;
`;

    // Same window, without the lifetime pass — only used if the query above fails.
    const fallbackSql = `
with bounds as (
  select
    (date_trunc('month', (now() at time zone '${tz}')) at time zone '${tz}') as month_start,
    ((date_trunc('month', (now() at time zone '${tz}')) + interval '1 month') at time zone '${tz}') as month_end,
    ((date_trunc('month', (now() at time zone '${tz}')) - interval '1 month') at time zone '${tz}') as scoring_start
)
select
  lower(f.email) as email,
  f.name as manager_name,
  a.client_id,
  l.id::text as ledger_id,
  a.id::text as attribution_id,
  l.manager_id::text as manager_id,
  l.created_at::text as ledger_created_at,
  (l.created_at at time zone '${tz}')::date::text as attribution_date,
  (l.created_at at time zone '${tz}')::text as occurred_at,
  (a.occurred_at at time zone '${tz}')::text as sale_occurred_at,
  (a.deleted_at is not null) as attribution_deleted,
  l.net_client_credit_amount::float8 as members,
  l.hours_amount::float8 as sessions
from sales_attribution.rep_scores_ledger_entries l
join sales_attribution.attributions a
  on a.id = l.attribution_id
join sales_attribution.flex_team_members f
  on f.manager_id = l.manager_id
 and f.deleted_at is null
cross join bounds b
where l.deleted_at is null
  and l.created_at >= b.month_start
  and l.created_at <  b.month_end
  and a.occurred_at >= b.scoring_start
  and a.occurred_at <  b.month_end
  and lower(f.email) in (${sqlStringList(emails)})
order by l.created_at asc, l.id asc;
`;

    // The lifetime totals need a second pass over the ledger for every journal in
    // the window. If that ever gets too slow for the SQL endpoint, serve the plain
    // window rather than 502 — a 502 leaves the browser showing the last good
    // numbers behind a one-line status note, which is exactly how a wrong cancel
    // total can sit on screen for an hour looking like a fix that did not work.
    let rawRows: LedgerRow[];
    let lifetimeAvailable = true;
    try {
      rawRows = await runSupabaseSql<LedgerRow>(sql);
    } catch (enrichedErr: any) {
      console.error("get-live-actuals lifetime query failed, falling back", enrichedErr);
      rawRows = await runSupabaseSql<LedgerRow>(fallbackSql);
      lifetimeAvailable = false;
    }
    const deletedAttribution = summarizeRows(rawRows.filter((row) => !!row.attribution_deleted));
    const exclusions = await loadLedgerExclusionIds();
    const reconciled = netLedgerJournal(rawRows, emailToDisplay, exclusions);
    const rows = reconciled.rows;
    const built = buildActuals(rows, emailToDisplay);
    const actuals = { asOf: built.asOf, perRep: built.perRep };
    const cancelItems = cancelLineItems(rows, emailToDisplay);
    const prelim = await maybeFreezePrelimAndCache(actuals);

    const fullPayload: Record<string, unknown> = {
      ok: true,
      source: "supabase",
      project: process.env.SUPABASE_PROJECT_REF || "oervjdxjjkhkyledsqag",
      rowCount: rows.length,
      rawRowCount: rawRows.length,
      matchedRows: built.matchedRows,
      unmatchedManagers: built.unmatchedManagers,
      // Surfaced rather than silently absorbed — if upstream duplication gets
      // worse, Ops should be able to see it.
      ledgerIntegrity: {
        suppressed: reconciled.suppressed,
        flagged: reconciled.flagged,
        netted: reconciled.netted,
        excludedIds: [...exclusions],
        window: {
          // Bumped whenever the counting rule changes, so "is this the build
          // with the fix?" is answerable from the dashboard instead of from
          // deploy timestamps.
          rule: LEDGER_RULE_VERSION,
          monthKeyColumn: "created_at",
          scoringRange: "current_and_prior_month",
          month: monthYmd,
          rawRows: rawRows.length,
          duplicateRows: reconciled.duplicateRows,
          periodDuplicatesDropped: reconciled.suppressed.filter(
            (s) => s.reason === "duplicate-period-line"
          ).length,
          lifetimeAvailable,
          deletedAttribution,
          cancelsBySaleMonth: summarizeCancelsBySaleMonth(rows, monthYmd),
        },
      },
      actuals,
      // Small enough to ship on every poll, and the only way the tiles and the
      // Cancels list can be checked against each other.
      cancelItems,
      fetchedAt: new Date().toISOString(),
      cacheHit: false,
    };
    if (prelim) fullPayload.prelim = prelim;

    try {
      await cacheStore.setJSON(LIVE_CACHE_KEY, {
        fetchedAtMs: Date.now(),
        payload: fullPayload,
      } satisfies LiveCacheDoc);
    } catch {
      // Cache write is best-effort.
    }

    return finish(fullPayload);
  } catch (err: any) {
    console.error("get-live-actuals failed", err);
    return new Response(
      JSON.stringify({ error: err?.message || "Failed to load live actuals" }),
      { status: 502, headers: { "Content-Type": "application/json" } }
    );
  }
};

export const config: Config = {
  path: "/api/actuals/live",
};
