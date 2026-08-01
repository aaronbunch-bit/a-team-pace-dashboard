import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { requireSignedIn } from "./_shared/identity.mts";
import { runSupabaseSql, supabaseConfig } from "./_shared/supabase.mts";
import { FALLBACK_ROSTER_EMAILS } from "./_shared/roster.mts";
import {
  LIVE_ACTUALS_CACHE_KEY,
  loadLedgerExclusionIds,
} from "./_shared/ledger-exclusions.mts";
import { TEAM_TIME_ZONE, clampAsOfToTeamToday, teamTodayYmd, teamTodayMonthKey } from "./_shared/time.mts";

/** Shared warm cache so N open tabs don't each hit Supabase every poll. */
const LIVE_CACHE_TTL_MS = 60_000;
/** Closed months do not change — keep them warm longer than the live month. */
const HISTORICAL_CACHE_TTL_MS = 10 * 60_000;
const LIVE_CACHE_KEY = LIVE_ACTUALS_CACHE_KEY;

function isMonthKey(value: string): boolean {
  return /^\d{4}-\d{2}$/.test(value);
}

/** Previous calendar month for a `YYYY-MM` key. */
function priorMonthKey(month: string): string {
  const [y, m] = month.split("-").map((n) => Number(n));
  if (!y || !m) return "";
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

/**
 * Resolve the month the caller wants to see.
 *
 * `?month=YYYY-MM` opens a closed (or still-current) month for the landing
 * Last-month toggle, the Individual Pacer Last Month tab, and the Team
 * Cancels/Goals prior-month views. Anything else falls back to today in
 * Chicago so a typo cannot query an unbounded window.
 */
function resolveRequestedMonth(url: URL): { month: string; isCurrent: boolean } {
  const current = teamTodayMonthKey();
  const raw = String(url.searchParams.get("month") || "").trim();
  if (isMonthKey(raw)) return { month: raw, isCurrent: raw === current };
  return { month: current, isCurrent: true };
}

function liveCacheKeyFor(month: string, isCurrent: boolean): string {
  return isCurrent ? LIVE_CACHE_KEY : `${LIVE_CACHE_KEY}:${month}`;
}

/**
 * SQL bounds for one Chicago calendar month: ledger lines created in the
 * month, sales that occurred in that month or the one before (scoring range).
 */
function monthBoundsCte(month: string, tz: string): string {
  // month is validated YYYY-MM before it reaches here.
  return `bounds as (
  select
    (timestamp '${month}-01' at time zone '${tz}') as month_start,
    ((timestamp '${month}-01' at time zone '${tz}') + interval '1 month') as month_end,
    ((timestamp '${month}-01' at time zone '${tz}') - interval '1 month') as scoring_start
)`;
}

/**
 * Counting rule the tiles were built with, shown on the Cancels panel.
 *
 * Four rewrites in a row all read the same -86.5 on screen, and there was no way
 * to tell a rule that had not worked from a build that had not shipped yet.
 */
const LEDGER_RULE_VERSION = "created_at+scoring+live-attro+transfer-wash-v4";

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
  reason: "admin-excluded" | "duplicate-period-line" | "orphan-cancel";
};

/**
 * A cancel that was written together with a credit re-booking a prior month's
 * sale into this one. Reported rather than counted as attrition — its value
 * stays in the attribution's credit row, so the members tile is unaffected.
 */
type WashedCancel = {
  ledgerId: string;
  attributionId: string;
  clientId: string;
  repName: string;
  members: number;
  sessions: number;
  date: string;
  saleMonth: string;
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

/**
 * Can this cancel be absorbed by the available credit / overshoot?
 *
 * Membership is the unit of attrition the tiles report. Sessions ride along
 * with a member line and sometimes disagree with it (a 0.5-member cancel of an
 * 8-session package against a 0.5/2 re-booking credit, for example). Requiring
 * both dimensions to fit was why the first wash only cleared 16 of 41
 * period-transfer lines and why the orphan rule cleared none of the SPIFF
 * cancels — the member side fitted and the session side did not, so the line
 * was kept as attrition. Absorb when the member side fits; sessions follow
 * for as far as the pool allows. A sessions-only cancel (no members) still
 * absorbs against the session pool alone.
 */
function cancelFitsPool(
  lostMembers: number,
  lostSessions: number,
  poolMembers: number,
  poolSessions: number
): boolean {
  if (lostMembers > EPSILON) return lostMembers <= poolMembers + EPSILON;
  if (lostSessions > EPSILON) return lostSessions <= poolSessions + EPSILON;
  return false;
}

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
 *
 * `windowMonth` (a `YYYY-MM` key) enables the period-transfer wash documented
 * inside. Omit it and the journal behaves exactly as before.
 */
export function netLedgerJournal(
  rows: LedgerRow[],
  emailToDisplay: Record<string, string>,
  exclusions: Set<string>,
  windowMonth?: string
): {
  rows: LedgerRow[];
  suppressed: SuppressedRow[];
  flagged: FlaggedPair[];
  netted: NettedAttribution[];
  duplicateRows: number;
  washed: WashedCancel[];
} {
  const washed: WashedCancel[] = [];
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

    // Drop bookkeeping cancels that push a journal below zero over all time.
    //
    // A genuine cancel of a prior-month sale nets to zero (the credit still
    // exists outside this window). An orphan cancel — a negative line with no
    // credit for this manager anywhere — nets below zero, and so does a
    // period-transfer duplicate. Drop cancel lines that fit inside that
    // overshoot, oldest first, even when the journal only has one cancel: the
    // single-line guard used to preserve orphans that the July export never
    // counted (Amanda/Jordan SPIFF cancels against sales credited to other
    // reps; ~-5.5 members of the -90.5 tile).
    const lifetimeMembers = Number(classified[0].lifetime_members);
    const lifetimeSessions = Number(classified[0].lifetime_sessions);
    let overMembers = Number.isFinite(lifetimeMembers) ? Math.max(0, -lifetimeMembers) : 0;
    let overSessions = Number.isFinite(lifetimeSessions) ? Math.max(0, -lifetimeSessions) : 0;
    if (overMembers > EPSILON || overSessions > EPSILON) {
      const surviving: LedgerRow[] = [];
      const cancelCountBefore = cancelLines.length;
      for (const row of cancelLines) {
        const lostMembers = -(Number(row.members) || 0);
        const lostSessions = -(Number(row.sessions) || 0);
        if (cancelFitsPool(lostMembers, lostSessions, overMembers, overSessions)) {
          overMembers = Math.max(0, overMembers - lostMembers);
          overSessions = Math.max(0, overSessions - Math.min(lostSessions, overSessions));
          suppressed.push({
            ledgerId: String(row.ledger_id || ""),
            attributionId: String(row.attribution_id || ""),
            clientId: String(row.client_id || ""),
            repName: displayFor(row),
            members: Number(row.members) || 0,
            sessions: Number(row.sessions) || 0,
            date: String(row.attribution_date || "").slice(0, 10),
            // One cancel and a negative lifetime: no credit for this manager
            // anywhere (orphan). Several cancels overshooting: period duplicate.
            reason: cancelCountBefore === 1 ? "orphan-cancel" : "duplicate-period-line",
          });
          continue;
        }
        surviving.push(row);
      }
      cancelLines = surviving;
    }
    // Wash period-transfer credits against the cancels they were written with.
    //
    // When a prior month's sale is cancelled, the ledger can re-book the credit
    // into the current month and cancel it in the same breath. Both lines are
    // written now, so the window sees +1 and -1 on a journal whose sale is
    // older than the window. The rep-scores export shows neither: those lines
    // belong to the month the sale lived in.
    //
    // Checked against the July export line by line: of the 44 prior-month
    // cancels the export does count, not one has a credit inside the window,
    // and all 41 the export omits do. Nothing is removed from the totals — the
    // washed line is folded into the attribution's credit row — so this moves
    // the cancel tile without moving the members tile.
    const saleMonth = String(classified[0].sale_occurred_at || "").slice(0, 7);
    const washedHere: LedgerRow[] = [];
    if (windowMonth && saleMonth && saleMonth < windowMonth && cancelLines.length) {
      let transferMembers = creditLines.reduce((sum, r) => sum + (Number(r.members) || 0), 0);
      let transferSessions = creditLines.reduce((sum, r) => sum + (Number(r.sessions) || 0), 0);
      if (transferMembers > EPSILON || transferSessions > EPSILON) {
        const surviving: LedgerRow[] = [];
        for (const row of cancelLines) {
          const lostMembers = -(Number(row.members) || 0);
          const lostSessions = -(Number(row.sessions) || 0);
          if (cancelFitsPool(lostMembers, lostSessions, transferMembers, transferSessions)) {
            transferMembers = Math.max(0, transferMembers - lostMembers);
            transferSessions = Math.max(0, transferSessions - Math.min(lostSessions, transferSessions));
            washedHere.push(row);
            washed.push({
              ledgerId: String(row.ledger_id || ""),
              attributionId: String(row.attribution_id || ""),
              clientId: String(row.client_id || ""),
              repName: displayFor(row),
              members: Number(row.members) || 0,
              sessions: Number(row.sessions) || 0,
              date: String(row.attribution_date || "").slice(0, 10),
              saleMonth,
            });
            continue;
          }
          surviving.push(row);
        }
        cancelLines = surviving;
      }
    }

    if (creditLines.length) {
      const settled = washedHere.length ? [...creditLines, ...washedHere] : creditLines;
      const netMembers = settled.reduce((sum, r) => sum + (Number(r.members) || 0), 0);
      const netSessions = settled.reduce((sum, r) => sum + (Number(r.sessions) || 0), 0);
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

  // Second wash pass: the re-booking credit and the cancel sometimes land on
  // *different* attributions for the same client + manager (a new attribution
  // is opened for the re-booked sale, the cancel closes the old one). The
  // per-journal wash above cannot see across that boundary. Checked against
  // the July dump after v3 shipped: 16 same-attribution pairs washed, ~25
  // prior-month cancels still on screen with no credit in their own journal —
  // exactly the cross-attribution shape. Of the prior-month cancels the export
  // keeps, none have any in-window credit for that client+manager, so washing
  // across attributions cannot touch a cancel the export counts.
  if (windowMonth) {
    type CreditSlot = { row: LedgerRow; members: number; sessions: number };
    const creditsByClientRep = new Map<string, CreditSlot[]>();
    for (const row of kept) {
      if (row.kind !== "credit") continue;
      const members = Number(row.members) || 0;
      const sessions = Number(row.sessions) || 0;
      if (members <= EPSILON && sessions <= EPSILON) continue;
      const key = `${String(row.client_id || "").trim()}|${displayFor(row)}`;
      const bucket = creditsByClientRep.get(key);
      const slot = { row, members, sessions };
      if (bucket) bucket.push(slot);
      else creditsByClientRep.set(key, [slot]);
    }

    const survivingKept: LedgerRow[] = [];
    for (const row of kept) {
      if (row.kind !== "cancel") {
        survivingKept.push(row);
        continue;
      }
      const saleMonth = String(row.sale_occurred_at || "").slice(0, 7);
      if (!saleMonth || saleMonth >= windowMonth) {
        survivingKept.push(row);
        continue;
      }
      const key = `${String(row.client_id || "").trim()}|${displayFor(row)}`;
      const pool = creditsByClientRep.get(key) || [];
      const lostMembers = -(Number(row.members) || 0);
      const lostSessions = -(Number(row.sessions) || 0);
      let washedInto: CreditSlot | null = null;
      for (const slot of pool) {
        if (!cancelFitsPool(lostMembers, lostSessions, slot.members, slot.sessions)) continue;
        // Fold the cancel into the credit the same way the per-journal wash
        // does — members and sessions both move — so the pair still nets to
        // whatever mismatch the two lines already had.
        slot.row.members = (Number(slot.row.members) || 0) + (Number(row.members) || 0);
        slot.row.sessions = (Number(slot.row.sessions) || 0) + (Number(row.sessions) || 0);
        slot.members = Number(slot.row.members) || 0;
        slot.sessions = Number(slot.row.sessions) || 0;
        washedInto = slot;
        break;
      }
      if (washedInto) {
        washed.push({
          ledgerId: String(row.ledger_id || ""),
          attributionId: String(row.attribution_id || ""),
          clientId: String(row.client_id || ""),
          repName: displayFor(row),
          members: Number(row.members) || 0,
          sessions: Number(row.sessions) || 0,
          date: String(row.attribution_date || "").slice(0, 10),
          saleMonth,
        });
        continue;
      }
      survivingKept.push(row);
    }

    // Drop credit rows the wash drove to zero — they were pure re-bookings.
    kept.length = 0;
    for (const row of survivingKept) {
      if (
        row.kind === "credit" &&
        Math.abs(Number(row.members) || 0) <= EPSILON &&
        Math.abs(Number(row.sessions) || 0) <= EPSILON
      ) {
        continue;
      }
      kept.push(row);
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

  return { rows: kept, suppressed, flagged, netted, duplicateRows, washed };
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
  const repOf = (row: LedgerRow) => {
    const email = safeEmail(row.email);
    return (email && emailToDisplay[email]) || String(row.manager_name || "Unknown rep");
  };

  // Credit that sits inside this window, at both grains a re-booking could use.
  // Shipped as diagnostics because the two wash rules built on this were tuned
  // against an assumption rather than measured: 16 of 41 lines had a credit on
  // their own attribution, and none of the remaining 25 had one at either
  // grain. These columns are what tell those 25 apart from the 44 the export
  // does count, without another round of guessing.
  const creditByAttribution = new Map<string, number>();
  const creditByClientRep = new Map<string, number>();
  for (const row of rows) {
    const members = Number(row.members) || 0;
    if (members <= 0) continue;
    const attrKey = `${String(row.attribution_id || "")}|${String(row.manager_id || "")}`;
    const clientKey = `${String(row.client_id || "").trim()}|${repOf(row)}`;
    creditByAttribution.set(attrKey, (creditByAttribution.get(attrKey) || 0) + members);
    creditByClientRep.set(clientKey, (creditByClientRep.get(clientKey) || 0) + members);
  }

  return rows
    .filter((row) => row.kind === "cancel")
    .map((row) => {
      const rep = repOf(row);
      const attrKey = `${String(row.attribution_id || "")}|${String(row.manager_id || "")}`;
      const clientKey = `${String(row.client_id || "").trim()}|${rep}`;
      const lifetime = Number(row.lifetime_members);
      return {
        rep,
        clientId: String(row.client_id || "").trim(),
        date: String(row.attribution_date || "").slice(0, 10),
        members: Math.min(Number(row.members) || 0, 0),
        sessions: Math.min(Number(row.sessions) || 0, 0),
        saleMonth: String(row.sale_occurred_at || "").slice(0, 7),
        ledgerId: String(row.ledger_id || "").trim(),
        attributionId: String(row.attribution_id || "").trim(),
        lifetimeMembers: Number.isFinite(lifetime) ? lifetime : null,
        attrWindowCredit: creditByAttribution.get(attrKey) || 0,
        clientRepWindowCredit: creditByClientRep.get(clientKey) || 0,
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
  const { month: monthYmd, isCurrent } = resolveRequestedMonth(url);
  const cacheKey = liveCacheKeyFor(monthYmd, isCurrent);
  const cacheTtlMs = isCurrent ? LIVE_CACHE_TTL_MS : HISTORICAL_CACHE_TTL_MS;
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
        const cached = (await cacheStore.get(cacheKey, { type: "json" })) as LiveCacheDoc | null;
        if (cached?.payload && Number(cached.fetchedAtMs) > 0) {
          const age = Date.now() - Number(cached.fetchedAtMs);
          if (age >= 0 && age < cacheTtlMs) {
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

    // Month key is l.created_at; sale (a.occurred_at) is this month or the prior
    // one. Soft-deleted attributions and orphan/transfer washes run in JS.
    // `?month=` selects a closed month for Last-month views; default is today.
    const tz = TEAM_TIME_ZONE.replace(/'/g, "''");
    const bounds = monthBoundsCte(monthYmd, tz);
    const sql = `
with ${bounds},
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
    and a.deleted_at is null
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

    const fallbackSql = `
with ${bounds}
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
  and a.deleted_at is null
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
    // Which date column does the export actually window on?
    //
    // Our month key is l.created_at. Matched line by line against the July
    // export, l.created_at equals the export's `update_timestamp` for 58 of 58
    // cancels, and its `attribution_date` for only 20 of 58. So the export
    // windows the month on a ledger business date we do not read: a June-dated
    // line that was touched in July stays in June's export but lands in our
    // July window. That is the shape of the 25 cancel lines still on the tile
    // with no offsetting credit anywhere in the window.
    //
    // Ship the column list so the right column can be named from evidence
    // instead of guessed at. Read-only, best effort, never fatal.
    let ledgerColumns: Record<string, string[]> | null = null;
    try {
      const cols = await runSupabaseSql<{ table_name: string; column_name: string; data_type: string }>(`
select table_name, column_name, data_type
from information_schema.columns
where table_schema = 'sales_attribution'
  and table_name in ('rep_scores_ledger_entries', 'attributions')
order by table_name, ordinal_position;
`);
      ledgerColumns = {};
      for (const c of cols) {
        const t = String(c.table_name);
        (ledgerColumns[t] ||= []).push(`${c.column_name}:${c.data_type}`);
      }
    } catch (schemaErr: any) {
      console.warn("get-live-actuals schema probe failed", schemaErr?.message || schemaErr);
    }

    const deletedAttribution = summarizeRows(rawRows.filter((row) => !!row.attribution_deleted));
    const exclusions = await loadLedgerExclusionIds();
    const reconciled = netLedgerJournal(rawRows, emailToDisplay, exclusions, monthYmd);
    const rows = reconciled.rows;
    const built = buildActuals(rows, emailToDisplay);
    const actuals = { asOf: built.asOf, perRep: built.perRep };
    const cancelItems = cancelLineItems(rows, emailToDisplay);
    // Only the live month freezes a prelim snapshot on rollover. Fetching July
    // in August must not rewrite August's warm cache or prelim.
    const prelim = isCurrent ? await maybeFreezePrelimAndCache(actuals) : null;

    const fullPayload: Record<string, unknown> = {
      ok: true,
      source: "supabase",
      project: process.env.SUPABASE_PROJECT_REF || "oervjdxjjkhkyledsqag",
      rowCount: rows.length,
      rawRowCount: rawRows.length,
      matchedRows: built.matchedRows,
      unmatchedManagers: built.unmatchedManagers,
      viewMonth: monthYmd,
      viewMonthIsCurrent: isCurrent,
      // Surfaced rather than silently absorbed — if upstream duplication gets
      // worse, Ops should be able to see it.
      ledgerIntegrity: {
        suppressed: reconciled.suppressed,
        flagged: reconciled.flagged,
        netted: reconciled.netted,
        washed: reconciled.washed,
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
            (s) => s.reason === "duplicate-period-line" || s.reason === "orphan-cancel"
          ).length,
          lifetimeAvailable,
          deletedAttribution,
          // Candidate month-key columns, so the next fix can name the right one.
          ledgerColumns,
          // Whether the period-transfer wash matched anything. A rule that
          // ships, deploys and quietly matches nothing is how the cancel tile
          // stayed wrong across several releases — so this is reported next to
          // the number it is supposed to move.
          transferWash: {
            rows: reconciled.washed.length,
            members: reconciled.washed.reduce((s, w) => s + w.members, 0),
            sessions: reconciled.washed.reduce((s, w) => s + w.sessions, 0),
          },
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
      await cacheStore.setJSON(cacheKey, {
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
