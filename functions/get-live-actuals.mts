import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { requireSignedIn } from "./_shared/identity.mts";
import { runSupabaseSql, supabaseConfig } from "./_shared/supabase.mts";
import { loadGoalsByMonth, saveGoalsByMonth } from "./_shared/goals.mts";
import {
  loadRosterByMonth,
  normalizeRosterEntries,
  saveRosterByMonth,
} from "./_shared/roster-months.mts";
import { FALLBACK_ROSTER_EMAILS } from "./_shared/roster.mts";
import {
  liveActualsCacheKey,
  loadLedgerExclusionIds,
} from "./_shared/ledger-exclusions.mts";
import { TEAM_TIME_ZONE, clampAsOfToTeamToday, teamTodayYmd, teamTodayMonthKey } from "./_shared/time.mts";

/** Shared warm cache so N open tabs don't each hit Supabase every poll. */
const LIVE_CACHE_TTL_MS = 60_000;
/** Closed months do not change — keep them warm longer than the live month. */
const HISTORICAL_CACHE_TTL_MS = 10 * 60_000;

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

function liveCacheKeyFor(month: string, _isCurrent: boolean): string {
  // Always month-scoped. Sharing one key for "whatever is current" lets a
  // July warm cache answer the first August poll after midnight.
  return liveActualsCacheKey(month);
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
const LEDGER_RULE_VERSION =
  "credit-occurred-month-v3+scoring+live-attro+transfer-wash-v5+credit-join+rebooked-credit";

/**
 * Columns worth testing as the export's month key.
 *
 * Settled: the export's `attribution_date` is `credits.occurred_at`, reached
 * through `rep_scores_ledger_entries.credit_id`. Joining the July dump onto
 * the July export by ledger id, filtering cancels to credit month = July
 * returns exactly the export's 58 lines / -50.5 — the same set, no line in one
 * and not the other. Ledger and attribution date columns stay in the dump as
 * evidence, not as the key.
 */
const MONTH_KEY_CANDIDATE_TYPES = new Set([
  "date",
  "timestamp with time zone",
  "timestamp without time zone",
  "text",
  "character varying",
  "character",
  "bigint",
  "integer",
  "numeric",
  "double precision",
  "real",
]);

const MONTH_KEY_DATE_TYPES = new Set([
  "date",
  "timestamp with time zone",
  "timestamp without time zone",
]);

/** Never worth testing as a business date. */
const MONTH_KEY_CANDIDATE_SKIP = new Set([
  "deleted_at",
  "id",
  "attribution_id",
  "manager_id",
  "client_id",
  "email",
  "name",
  "role",
  "product_type",
  "multiplier",
  "amount",
  "hours",
  "hours_amount",
  "net_client_credit_amount",
  "conference_ids",
  "conference_id_timestamps",
  "last_updated_by",
]);

/** Name looks like it could hold a calendar day. */
const MONTH_KEY_NAME_RE =
  /(date|time|at$|_at$|when|scored|effective|business|period|month|day|on$)/i;

/** Keeps the generated select (and the CSV) to a readable width. */
const MONTH_KEY_CANDIDATE_LIMIT = 32;

type MonthKeyCandidate = {
  /** Alias used in SQL (`cand_…`) and in the CSV header. */
  alias: string;
  /** Qualified column, e.g. `l.created_at` or `a.occurred_at`. */
  expr: string;
  type: string;
  table: "rep_scores_ledger_entries" | "attributions" | "credits";
  column: string;
};

/** How the live query matches `l.credit_id` onto `sales_attribution.credits`. */
type CreditJoinPlan = {
  enabled: boolean;
  /** SQL boolean expression joining alias `c` to ledger `l`. */
  onClause: string;
  idColumns: string[];
  /** Date/timestamp columns on credits, preferred first. */
  dateColumns: { name: string; type: string }[];
  /**
   * Coalesce of preferred credit date columns → calendar day text in team TZ.
   * Null when credits has no date-typed column we can read.
   */
  businessDateExpr: string | null;
  /**
   * Same preference order as a timestamp, for comparing against the month
   * bounds. Null when credits has no usable date column.
   */
  businessAtExpr: string | null;
  /**
   * When the credit was earned → calendar day text in team TZ. Cancellation
   * columns are excluded, so this is the month a *positive* line belongs to.
   */
  occurredDateExpr: string | null;
  /** Timestamp behind `occurredDateExpr`, for windowing against the bounds. */
  occurredAtExpr: string | null;
};

/** Column names on `credits` that might equal `l.credit_id`. */
const CREDIT_ID_COLUMN_RE = /^(id|uuid|guid|credit_id|external_id|public_id|source_id|.+_uuid)$/i;

/** Prefer these credit dates as the export's `attribution_date`. */
const CREDIT_BUSINESS_DATE_PRIORITY = [
  "attribution_date",
  "cancelled_at",
  "canceled_at",
  "cancellation_date",
  "cancellation_at",
  "effective_date",
  "effective_at",
  "occurred_at",
  "posted_at",
  "credit_date",
  "business_date",
  "scored_at",
  "created_at",
];

/**
 * When the credit itself was earned, ignoring anything that dates its undoing.
 *
 * A positive line belongs to the month its credit occurred in. The cancellation
 * columns above must not decide that: a sale credited in August and cancelled in
 * September is still August's credit, so keying the credit line on
 * `cancelled_at` would move it out of the month it was earned in.
 *
 * Deliberately limited to this list rather than "every date column that is not a
 * cancellation" — an unrecognised column (`updated_at`, a sync stamp) moves with
 * edits, and a credit line must not follow it into another month.
 */
const CREDIT_OCCURRED_DATE_PRIORITY = [
  "attribution_date",
  "effective_date",
  "effective_at",
  "occurred_at",
  "posted_at",
  "credit_date",
  "business_date",
  "scored_at",
  "created_at",
];

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
   * This negative line was written in the same breath as positive credit for a
   * *different* rep on the same attribution — the sale moved, it was not lost.
   * The export drops both halves of that swap; the pacer used to count the
   * negative half as attrition.
   */
  transferred_out?: boolean;
  /** Ledger row `type` — the only remaining on-row discriminator the schema has. */
  ledger_type?: string;
  /** Attribution `type`. */
  attr_type?: string;
  /** Optional link to a credit line; present on some cancels. */
  credit_id?: string;
  /**
   * True when `l.credit_id` resolved to a `credits` row. False when the join
   * ran and found nothing (or credit_id was blank). Undefined when the credits
   * join was not available — journal must not wash on an absent signal.
   */
  credit_matched?: boolean;
  /**
   * Preferred business day from the joined credits row (team TZ calendar day).
   * When present and outside the window month, the cancel is washed the same
   * way an unresolved credit_id is — the export windows on this day, not on
   * `l.created_at`.
   */
  credit_business_date?: string;
  /**
   * The joined credit's own day, excluding anything that dates its cancellation
   * (team TZ calendar day). This is the month a *positive* line belongs to: a
   * re-booking written this month against an older credit is that credit's
   * month, not this one's.
   */
  credit_occurred_date?: string;
  /**
   * Every date column on the ledger row, keyed by column name, so the month key
   * the export windows on can be named from evidence. Diagnostics only — no
   * total is computed from these.
   */
  month_key_candidates?: Record<string, string>;
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
  /**
   * transfer = same-write rebook; orphan-credit = no credits row;
   * credit-month = credit occurred in another month;
   * rebooked-credit = a *positive* line re-booking a credit earned in another
   * month, so its members and sessions belong to that month's pace.
   */
  reason?: "transfer" | "orphan-credit" | "credit-month" | "rebooked-credit";
  /** For credit-month / rebooked-credit: the month the export files this line under. */
  creditMonth?: string;
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
    let creditLines = classified.filter((r) => r.kind !== "cancel");
    let cancelLines = classified.filter((r) => r.kind === "cancel");

    // Drop credit that was earned in another month.
    //
    // Cancels are filed under the month their credit occurred in; so is credit
    // itself. The two only disagree when the ledger re-books an older sale: the
    // rebook is written today, so `l.created_at` puts a July credit in August
    // while its reversal — keyed on the credit — stays in July. August was then
    // left holding a positive line with nothing to net against, and a client
    // whose journal is zero over its lifetime still added members and sessions
    // to this month's pace. Client 8561610 (credited 0.5/2 on 7/2, refunded
    // 7/3) reached August's numbers exactly this way.
    //
    // The live query now windows on the same key, so normally nothing reaches
    // here; it runs anyway because a cached payload or the no-credits fallback
    // query can still carry lines keyed the old way, and both must total alike.
    //
    // Only fires on a resolved credits row with a usable occurrence day, so an
    // unavailable join cannot silently delete credit.
    const rebookedMonthOf = (row: LedgerRow) => {
      if (row.credit_matched !== true) return "";
      const day = String(row.credit_occurred_date || "").slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return "";
      const month = day.slice(0, 7);
      return month === windowMonth ? "" : month;
    };
    if (windowMonth && creditLines.length) {
      const isPositive = (row: LedgerRow) =>
        (Number(row.members) || 0) > 0 || (Number(row.sessions) || 0) > 0;
      const rebooked = creditLines.filter((r) => isPositive(r) && rebookedMonthOf(r));
      if (rebooked.length) {
        const keptCredit = creditLines.filter((r) => !rebooked.includes(r));
        // A reversal only exists to revise a credit in its own journal write. If
        // no credit line survives, the revisions belong to that other month too
        // — keeping them would post this month a negative credit row.
        const survivors = keptCredit.some(isPositive) ? keptCredit : [];
        for (const row of creditLines) {
          if (survivors.includes(row)) continue;
          washed.push({
            ledgerId: String(row.ledger_id || ""),
            attributionId: String(row.attribution_id || ""),
            clientId: String(row.client_id || ""),
            repName: displayFor(row),
            members: Number(row.members) || 0,
            sessions: Number(row.sessions) || 0,
            date: String(row.attribution_date || "").slice(0, 10),
            saleMonth: String(classified[0].sale_occurred_at || "").slice(0, 7),
            reason: "rebooked-credit",
            creditMonth: rebookedMonthOf(row) || undefined,
          });
        }
        creditLines = survivors;
      }
    }

    // Drop bookkeeping cancels that push a journal below zero over all time.
    //
    // A genuine cancel of a prior-month sale nets to zero (the credit still
    // exists outside this window). An orphan cancel — a negative line with no
    // credit for this manager anywhere — nets below zero, and so does a
    // period-transfer duplicate. Drop cancel lines that fit inside that
    // overshoot, oldest first, even when the journal only has one cancel.
    //
    // This catches less than it reads like it should: every one of the 93 lines
    // on the July tile has a lifetime of exactly zero, because a cancel always
    // offsets its own rep's credit. Lifetime tells a double-charged journal
    // apart from a sound one; it cannot tell a cancel the export counts apart
    // from one it omits. `transferred_out` below is what does that.
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
    // Joined onto the July export by ledger id: of the 42 prior-month cancels
    // the export does count, not one has a credit inside the window. Nothing is
    // removed from the totals — the
    // washed line is folded into the attribution's credit row — so this moves
    // the cancel tile without moving the members tile.
    //
    // A sale that moved to another rep has the same shape but no month change:
    // the credit and the reversal are both written today, on today's sale. The
    // export drops the losing rep's whole pair — it lists only the reps who
    // hold the attribution now — so a same-month cancel is also washed when the
    // ledger wrote positive credit for a different rep in the same breath
    // (`transferred_out`). Joined onto the July export by ledger id, that flag
    // covers exactly the 8 lines (-4.0) the export omits while this rep's other
    // 16 same-month cancels — real attrition, still credited to them — are
    // untouched.
    const saleMonth = String(classified[0].sale_occurred_at || "").slice(0, 7);
    const priorMonthSale = !!(saleMonth && windowMonth && saleMonth < windowMonth);
    const washable = (row: LedgerRow) => priorMonthSale || row.transferred_out === true;
    const washedHere: LedgerRow[] = [];
    if (windowMonth && cancelLines.some(washable)) {
      let transferMembers = creditLines.reduce((sum, r) => sum + (Number(r.members) || 0), 0);
      let transferSessions = creditLines.reduce((sum, r) => sum + (Number(r.sessions) || 0), 0);
      if (transferMembers > EPSILON || transferSessions > EPSILON) {
        const surviving: LedgerRow[] = [];
        for (const row of cancelLines) {
          const lostMembers = -(Number(row.members) || 0);
          const lostSessions = -(Number(row.sessions) || 0);
          if (washable(row) && cancelFitsPool(lostMembers, lostSessions, transferMembers, transferSessions)) {
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
              reason: "transfer",
            });
            continue;
          }
          surviving.push(row);
        }
        cancelLines = surviving;
      }
    }

    // Put every cancel in the month its credit occurred in, which is the month
    // the rep-scores export puts it in.
    //
    // `credits.occurred_at` *is* the export's `attribution_date`: joining the
    // July dump onto the July export by ledger id, the cancels whose credit
    // occurred in July are exactly the export's 58 lines / -50.5 — no line in
    // one set and not the other. Keying on `l.created_at` (when the reversal
    // was written) dragged 27 June-credit cancels, -23.5, into July.
    //
    // The live query already windows on this, so in the normal path nothing
    // reaches here. It runs anyway because a cached payload, the no-credits
    // fallback query or a replayed dump can still carry out-of-month lines,
    // and the tile must read the same number whichever produced it.
    //
    // A credit-month line is *removed*, not folded into the attribution's
    // credit: it belongs to another month, so its value must not be netted
    // against a credit that belongs to this one. An unresolved credit_id
    // (`credit_matched === false`) is folded, like a transfer — the export has
    // no such row at all. `credit_matched` stays undefined when the join is
    // unavailable, so a failed probe cannot zero the tile.
    const creditMonthOf = (row: LedgerRow) => {
      if (row.credit_matched !== true) return "";
      const day = String(row.credit_business_date || "").slice(0, 10);
      return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day.slice(0, 7) : "";
    };
    const outOfCreditMonth = (row: LedgerRow) => {
      const month = creditMonthOf(row);
      return !!month && month !== windowMonth;
    };
    if (
      windowMonth &&
      cancelLines.some((r) => r.credit_matched === false || outOfCreditMonth(r))
    ) {
      const surviving: LedgerRow[] = [];
      for (const row of cancelLines) {
        const orphan = row.credit_matched === false;
        if (orphan || outOfCreditMonth(row)) {
          if (orphan) washedHere.push(row);
          washed.push({
            ledgerId: String(row.ledger_id || ""),
            attributionId: String(row.attribution_id || ""),
            clientId: String(row.client_id || ""),
            repName: displayFor(row),
            members: Number(row.members) || 0,
            sessions: Number(row.sessions) || 0,
            date: String(row.attribution_date || "").slice(0, 10),
            saleMonth,
            reason: orphan ? "orphan-credit" : "credit-month",
            creditMonth: creditMonthOf(row) || undefined,
          });
          continue;
        }
        surviving.push(row);
      }
      cancelLines = surviving;
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

  // There is deliberately no wash across attributions.
  //
  // v4 added one, on the theory that the ~25 prior-month cancels left on the
  // July tile were re-bookings whose credit had opened a *new* attribution for
  // the same client and rep. It matched nothing, and joining the dump onto the
  // export by ledger id says why: those 25 lines are simply not in the July
  // export at any grain, and none of them has in-window credit for that client
  // and rep on any attribution. They are a month-window artifact, not a
  // re-booking. The export lists ledger rows and never nets across
  // attributions, so neither does this.

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
  // Diagnostics: they proved that the 25 lines the export has no record of have
  // no in-window credit at either grain, which is what retired the
  // cross-attribution wash. They are reported, never counted.
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
      // The export dates a cancel by its credit's `occurred_at`, so the list
      // and a rep-scores export line up row for row. The day the reversal was
      // written stays on the row as `ledgerDate` for anyone reconciling the
      // ledger itself.
      const ledgerDay = String(row.attribution_date || "").slice(0, 10);
      const businessDay = String(row.credit_business_date || "").slice(0, 10);
      const shownDate =
        row.credit_matched === true && /^\d{4}-\d{2}-\d{2}$/.test(businessDay)
          ? businessDay
          : ledgerDay;
      return {
        rep,
        clientId: String(row.client_id || "").trim(),
        date: shownDate,
        ledgerDate: ledgerDay,
        members: Math.min(Number(row.members) || 0, 0),
        sessions: Math.min(Number(row.sessions) || 0, 0),
        saleMonth: String(row.sale_occurred_at || "").slice(0, 7),
        ledgerId: String(row.ledger_id || "").trim(),
        attributionId: String(row.attribution_id || "").trim(),
        lifetimeMembers: Number.isFinite(lifetime) ? lifetime : null,
        attrWindowCredit: creditByAttribution.get(attrKey) || 0,
        clientRepWindowCredit: creditByClientRep.get(clientKey) || 0,
        transferredOut: row.transferred_out === true,
        ledgerType: String(row.ledger_type || "").trim(),
        attrType: String(row.attr_type || "").trim(),
        creditId: String(row.credit_id || "").trim(),
        creditMatched:
          row.credit_matched === undefined ? null : row.credit_matched === true,
        creditBusinessDate: String(row.credit_business_date || "").slice(0, 10) || null,
        // The credit's own day, cancellation columns excluded — what decides the
        // month a positive line lands in.
        creditOccurredDate: String(row.credit_occurred_date || "").slice(0, 10) || null,
        monthKeyCandidates: row.month_key_candidates || {},
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

/**
 * Schema probe: ledger/attribution/credits columns, month-key candidates,
 * every table in the attribution schema, and any `attribution_date` column
 * anywhere in the DB.
 *
 * The col-probe dump proved ledger + attributions have no business-date column
 * matching the export. `credits` is the remaining join via `l.credit_id`.
 */
async function loadLedgerSchema(): Promise<{
  columns: Record<string, string[]> | null;
  candidates: MonthKeyCandidate[];
  tables: string[];
  attributionDateColumns: string[];
  creditJoin: CreditJoinPlan;
}> {
  const emptyJoin: CreditJoinPlan = {
    enabled: false,
    onClause: "false",
    idColumns: [],
    dateColumns: [],
    businessDateExpr: null,
    businessAtExpr: null,
  };
  try {
    const cols = await runSupabaseSql<{
      table_name: string;
      column_name: string;
      data_type: string;
    }>(`
select table_name, column_name, data_type
from information_schema.columns
where table_schema = 'sales_attribution'
  and table_name in (
    'rep_scores_ledger_entries', 'attributions', 'credits',
    'sessions', 'calls', 'clients'
  )
order by
  case table_name
    when 'rep_scores_ledger_entries' then 0
    when 'attributions' then 1
    when 'credits' then 2
    else 3
  end,
  ordinal_position;
`);
    const columns: Record<string, string[]> = {};
    const candidates: MonthKeyCandidate[] = [];
    const seen = new Set<string>();
    const creditColRows: { name: string; type: string }[] = [];
    for (const c of cols) {
      const table = String(c.table_name);
      const name = String(c.column_name);
      const type = String(c.data_type);
      (columns[table] ||= []).push(`${name}:${type}`);
      if (table === "credits") creditColRows.push({ name, type });
      if (
        table !== "rep_scores_ledger_entries" &&
        table !== "attributions" &&
        table !== "credits"
      ) {
        continue;
      }
      if (MONTH_KEY_CANDIDATE_SKIP.has(name)) continue;
      if (!MONTH_KEY_CANDIDATE_TYPES.has(type)) continue;
      const isDateType = MONTH_KEY_DATE_TYPES.has(type);
      if (!isDateType && !MONTH_KEY_NAME_RE.test(name)) continue;
      if (!/^[a-z_][a-z0-9_]*$/.test(name)) continue;
      const alias =
        table === "attributions" ? `a_${name}` : table === "credits" ? `c_${name}` : name;
      if (seen.has(alias)) continue;
      if (candidates.length >= MONTH_KEY_CANDIDATE_LIMIT) continue;
      seen.add(alias);
      const expr =
        table === "attributions" ? `a.${name}` : table === "credits" ? `c.${name}` : `l.${name}`;
      candidates.push({
        alias,
        expr,
        type,
        table: table as MonthKeyCandidate["table"],
        column: name,
      });
    }
    candidates.sort((a, b) => {
      const score = (c: MonthKeyCandidate) => {
        let s = 0;
        if (c.column === "attribution_date") s += 100;
        if (c.table === "credits") s += 50;
        if (c.column.includes("attribution")) s += 40;
        if (c.column.includes("business") || c.column.includes("effective")) s += 30;
        if (c.column.includes("cancel")) s += 25;
        if (c.table === "rep_scores_ledger_entries") s += 10;
        if (MONTH_KEY_DATE_TYPES.has(c.type)) s += 5;
        return -s;
      };
      return score(a) - score(b) || a.alias.localeCompare(b.alias);
    });

    let tables: string[] = [];
    try {
      const tableRows = await runSupabaseSql<{ table_name: string }>(`
select table_name
from information_schema.tables
where table_schema = 'sales_attribution'
order by table_name;
`);
      tables = tableRows.map((r) => String(r.table_name));
    } catch (err: any) {
      console.warn("get-live-actuals table list failed", err?.message || err);
    }

    let attributionDateColumns: string[] = [];
    try {
      const dateRows = await runSupabaseSql<{
        table_schema: string;
        table_name: string;
        column_name: string;
        data_type: string;
      }>(`
select table_schema, table_name, column_name, data_type
from information_schema.columns
where column_name in (
  'attribution_date', 'business_date', 'effective_date', 'score_date', 'scoring_date'
)
order by table_schema, table_name, column_name;
`);
      attributionDateColumns = dateRows.map(
        (r) => `${r.table_schema}.${r.table_name}.${r.column_name}:${r.data_type}`
      );
    } catch (err: any) {
      console.warn("get-live-actuals attribution_date search failed", err?.message || err);
    }

    const creditJoin = buildCreditJoinPlan(creditColRows);

    return { columns, candidates, tables, attributionDateColumns, creditJoin };
  } catch (err: any) {
    console.warn("get-live-actuals schema probe failed", err?.message || err);
    return {
      columns: null,
      candidates: [],
      tables: [],
      attributionDateColumns: [],
      creditJoin: emptyJoin,
    };
  }
}

/**
 * Build a left-join plan for `sales_attribution.credits` from its columns.
 *
 * `l.credit_id` is text and holds both numeric CRM ids and UUIDs, so every
 * id-shaped column on credits is OR'd into the ON clause via `::text`.
 */
export function buildCreditJoinPlan(
  creditCols: { name: string; type: string }[],
  tz = TEAM_TIME_ZONE.replace(/'/g, "''")
): CreditJoinPlan {
  if (!creditCols.length) {
    return {
      enabled: false,
      onClause: "false",
      idColumns: [],
      dateColumns: [],
      businessDateExpr: null,
      businessAtExpr: null,
      occurredDateExpr: null,
      occurredAtExpr: null,
    };
  }
  const idColumns = creditCols
    .map((c) => c.name)
    .filter((name) => CREDIT_ID_COLUMN_RE.test(name) && /^[a-z_][a-z0-9_]*$/.test(name));
  // Always try `id` if present even when the regex somehow misses it.
  if (!idColumns.includes("id") && creditCols.some((c) => c.name === "id")) {
    idColumns.unshift("id");
  }
  const dateColumns = creditCols.filter(
    (c) => MONTH_KEY_DATE_TYPES.has(c.type) && /^[a-z_][a-z0-9_]*$/.test(c.name) && c.name !== "deleted_at"
  );
  dateColumns.sort((a, b) => {
    const rank = (name: string) => {
      const i = CREDIT_BUSINESS_DATE_PRIORITY.indexOf(name);
      return i === -1 ? 100 + name.length : i;
    };
    return rank(a.name) - rank(b.name) || a.name.localeCompare(b.name);
  });

  const idMatch =
    idColumns.length > 0
      ? idColumns.map((col) => `c.${col}::text = btrim(l.credit_id)`).join("\n      or ")
      : "false";
  const onClause = `(
    nullif(btrim(coalesce(l.credit_id, '')), '') is not null
    and (
      ${idMatch}
    )
  )`;

  const businessParts = dateColumns.map(({ name, type }) => {
    if (type === "date") return `c.${name}::text`;
    return `(c.${name} at time zone '${tz}')::date::text`;
  });
  const businessDateExpr = businessParts.length ? `coalesce(${businessParts.join(", ")})` : null;

  // Raw timestamp behind the same preference order, for windowing the month.
  // The day text above is for display; the month test must compare timestamps
  // against the bounds CTE so a cancel written after month end still lands in
  // the month its credit occurred in.
  const timestampParts = dateColumns
    .filter(({ type }) => type !== "date")
    .map(({ name }) => `c.${name}`);
  const dateOnlyParts = dateColumns
    .filter(({ type }) => type === "date")
    .map(({ name }) => `(c.${name}::timestamp at time zone '${tz}')`);
  const allParts = [...timestampParts, ...dateOnlyParts];
  const businessAtExpr = allParts.length
    ? allParts.length === 1
      ? allParts[0]
      : `coalesce(${allParts.join(", ")})`
    : null;

  // Same shape again over occurrence-only columns, in that list's own order, so
  // a credit line is dated by when it was earned rather than when it was undone.
  const occurredColumns = CREDIT_OCCURRED_DATE_PRIORITY
    .map((name) => dateColumns.find((c) => c.name === name))
    .filter((c): c is { name: string; type: string } => !!c);
  const occurredDayParts = occurredColumns.map(({ name, type }) =>
    type === "date" ? `c.${name}::text` : `(c.${name} at time zone '${tz}')::date::text`
  );
  const occurredAtParts = occurredColumns.map(({ name, type }) =>
    type === "date" ? `(c.${name}::timestamp at time zone '${tz}')` : `c.${name}`
  );
  const coalesced = (parts: string[]) =>
    parts.length ? (parts.length === 1 ? parts[0] : `coalesce(${parts.join(", ")})`) : null;

  return {
    enabled: idColumns.length > 0,
    onClause,
    idColumns,
    dateColumns,
    businessDateExpr,
    businessAtExpr,
    occurredDateExpr: coalesced(occurredDayParts),
    occurredAtExpr: coalesced(occurredAtParts),
  };
}

/**
 * The timestamp that decides which month a ledger line belongs to.
 *
 * Negative lines use the credit's business day (cancellation columns included —
 * that is the parity the July export was reconciled against). Positive lines use
 * the day the credit was earned. Both fall back to `l.created_at`, so a missing
 * join or a credit with no usable date behaves exactly as it did before.
 *
 * Exported so a test can parse the SQL it produces.
 */
export function liveMonthKeyExpr(creditJoin: CreditJoinPlan): string {
  if (!creditJoin.enabled) return "l.created_at";
  const { businessAtExpr, occurredAtExpr } = creditJoin;
  if (!businessAtExpr && !occurredAtExpr) return "l.created_at";
  const negative = businessAtExpr ? `coalesce(${businessAtExpr}, l.created_at)` : "l.created_at";
  const positive = occurredAtExpr ? `coalesce(${occurredAtExpr}, l.created_at)` : "l.created_at";
  return `(case
      when l.net_client_credit_amount < 0 or l.hours_amount < 0
        then ${negative}
      else ${positive}
    end)`;
}

/**
 * What each candidate column would score if the month were keyed on it.
 *
 * After the attr-dates dump, every date-typed column kept either too few lines
 * (a_occurred_at: 17 / -14) or all of them (created_at/updated_at/a_updated_at:
 * 86 / -74.5). The export's attribution_date still matches none of them on
 * most keeps — so the next probe includes name-matched scalar columns too.
 * The column that keeps ~58 lines is the one to switch the window onto.
 */
function summarizeMonthKeyCandidates(rows: LedgerRow[], month: string) {
  const cancels = rows.filter((r) => r.kind === "cancel");
  const names = new Set<string>();
  for (const row of cancels) {
    for (const name of Object.keys(row.month_key_candidates || {})) names.add(name);
  }
  return [...names].sort().map((column) => {
    const inMonth = cancels.filter((r) => (r.month_key_candidates || {})[column]?.startsWith(month));
    return {
      column,
      ...summarizeRows(inMonth),
      outOfMonthRows: cancels.length - inMonth.length,
    };
  });
}

/**
 * Cancel lines split by ledger `type` / attribution `type`.
 *
 * Those two tables have no business-date column. `type` is the only remaining
 * on-row field that could separate the 58 cancels the export keeps from the 28
 * it omits — so the breakdown is shipped next to the total, not buried in a
 * dump the next release has to re-ask for.
 */
function summarizeCancelTypes(rows: LedgerRow[]) {
  const cancels = rows.filter((r) => r.kind === "cancel");
  const byLedger = new Map<string, LedgerRow[]>();
  const byAttr = new Map<string, LedgerRow[]>();
  for (const row of cancels) {
    const lt = String(row.ledger_type || "").trim() || "(blank)";
    const at = String(row.attr_type || "").trim() || "(blank)";
    (byLedger.get(lt) || byLedger.set(lt, []).get(lt)!).push(row);
    (byAttr.get(at) || byAttr.set(at, []).get(at)!).push(row);
  }
  const summarize = (map: Map<string, LedgerRow[]>) =>
    [...map.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([type, list]) => ({ type, ...summarizeRows(list) }));
  return { ledger: summarize(byLedger), attribution: summarize(byAttr) };
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

    // Settle the outgoing month's quotas so last-month views keep reading them
    // after this month's are edited. Best effort: a rollover must not fail on
    // the archive write.
    try {
      const byMonth = await loadGoalsByMonth();
      if (!byMonth[oldMonth] && goals && Object.keys(goals).length) {
        byMonth[oldMonth] = goals;
        await saveGoalsByMonth(byMonth);
      }
    } catch (err: any) {
      console.warn("get-live-actuals goals-month freeze failed", err?.message || err);
    }

    // Same for roster: removing someone in the new month must not erase them
    // from the closed month's boards.
    try {
      const roster = normalizeRosterEntries(
        await getStore("roster").get("current", { type: "json" })
      );
      const byMonth = await loadRosterByMonth();
      if (!byMonth[oldMonth] && roster.length) {
        byMonth[oldMonth] = roster.map((r) => ({ ...r, active: true }));
        await saveRosterByMonth(byMonth);
      }
    } catch (err: any) {
      console.warn("get-live-actuals roster-month freeze failed", err?.message || err);
    }
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

    // Read the ledger's shape before querying it, so every date column it has
    // can be carried on the row and measured against the month. Best effort:
    // the query below runs with no candidates if this fails.
    const schema = await loadLedgerSchema();
    const creditJoin = schema.creditJoin;
    // Credits date candidates need the join; drop them when the join is off so
    // the select list never references alias `c` without a FROM entry.
    const candidateColumns = schema.candidates.filter(
      (c) => c.table !== "credits" || creditJoin.enabled
    );
    const candidateSelect = candidateColumns
      .map(({ alias, expr, type }) => {
        // Date-typed columns need the team zone; everything else is cast to text
        // and clipped to a calendar day so a text/numeric store of the export's
        // attribution_date still scores. Credits columns are null when the join
        // misses — left() of null stays null and is dropped from candidates.
        const asDay = MONTH_KEY_DATE_TYPES.has(type)
          ? type === "date"
            ? `${expr}::text`
            : `(${expr} at time zone '${tz}')::date::text`
          : `left((${expr})::text, 10)`;
        return `  ${asDay} as "cand_${alias}"`;
      })
      .join(",\n");
    const candidateSelectFromWin = candidateColumns
      .map(({ alias }) => `  win."cand_${alias}"`)
      .join(",\n");

    const creditHasDeletedAt = (schema.columns?.credits || []).some((c) =>
      c.startsWith("deleted_at:")
    );
    const creditJoinSql = creditJoin.enabled
      ? `left join sales_attribution.credits c
    on ${creditJoin.onClause}${creditHasDeletedAt ? "\n   and c.deleted_at is null" : ""}`
      : "";
    const creditMatchedExpr =
      creditJoin.enabled && creditJoin.idColumns.includes("id")
        ? "(c.id is not null)"
        : creditJoin.enabled
          ? `(${creditJoin.idColumns.map((col) => `c.${col} is not null`).join(" or ") || "false"})`
          : "null";

    // Which timestamp decides the month a line belongs to.
    //
    // For a cancel it is `credits.occurred_at` — the export's
    // `attribution_date`. Joining the July dump onto the July rep-scores
    // export by ledger id, cancels whose credit occurred in July are exactly
    // the export's 58 lines / -50.5: same set both ways. `l.created_at` (when
    // the reversal was *written*) put 27 June-credit cancels, -23.5, into July.
    //
    // A credit line is keyed the same way, on the month its credit was earned.
    // A sale's credit row is normally written with the sale, so for ordinary
    // in-month business the two agree and nothing moves. They come apart when
    // the ledger re-books an older sale: the rebook is written now, so
    // `l.created_at` filed a July credit under August while the matching
    // reversal — already keyed on the credit — stayed in July. That left the
    // rebook in August with nothing to net against, and a client whose journal
    // nets to zero still added members and sessions to this month's pace.
    //
    // Cancellation columns are excluded here (see CREDIT_OCCURRED_DATE_PRIORITY)
    // so cancelling a credit never moves the credit out of the month it was
    // earned in, and the expression falls back to `l.created_at` whenever the
    // join misses or the credit carries no occurrence date.
    const monthKeyExpr = liveMonthKeyExpr(creditJoin);

    // Did the ledger hand this sale to a different rep at the moment it wrote
    // this line? Transfers are written as one transaction — the losing rep's
    // reversal and the winning rep's credit land together — so a positive line
    // for another manager alongside this negative one is a move, not a loss.
    // Scoped to negative lines: the tiles only ever ask this of a cancel.
    const transferredOut = `
    case
      when l.net_client_credit_amount < 0 or l.hours_amount < 0 then exists (
        select 1
        from sales_attribution.rep_scores_ledger_entries t
        where t.attribution_id = l.attribution_id
          and t.deleted_at is null
          and t.manager_id <> l.manager_id
          and t.net_client_credit_amount > 0
          and t.created_at between l.created_at - interval '5 seconds'
                               and l.created_at + interval '5 seconds'
      )
      else false
    end as transferred_out`;

    const winSelect = `
  select
    l.id as ledger_id,
    l.attribution_id,
    l.manager_id,
    l.created_at,
    l.net_client_credit_amount,
    l.hours_amount,
    l.type as ledger_type,
    l.credit_id,
    a.client_id,
    a.type as attr_type,
    a.occurred_at as sale_occurred_at,
    (a.deleted_at is not null) as attribution_deleted,
    lower(f.email) as email,
    f.name as manager_name,${transferredOut}${
      creditJoin.enabled
        ? `,\n    ${creditMatchedExpr} as credit_matched${
            creditJoin.businessDateExpr
              ? `,\n    ${creditJoin.businessDateExpr} as credit_business_date`
              : `,\n    null::text as credit_business_date`
          }${
            creditJoin.occurredDateExpr
              ? `,\n    ${creditJoin.occurredDateExpr} as credit_occurred_date`
              : `,\n    null::text as credit_occurred_date`
          }`
        : ""
    }${candidateSelect ? `,\n${candidateSelect}` : ""}
  from sales_attribution.rep_scores_ledger_entries l
  join sales_attribution.attributions a
    on a.id = l.attribution_id
  join sales_attribution.flex_team_members f
    on f.manager_id = l.manager_id
   and f.deleted_at is null
  ${creditJoinSql}
  cross join bounds b
  where l.deleted_at is null
    and a.deleted_at is null
    and ${monthKeyExpr} >= b.month_start
    and ${monthKeyExpr} <  b.month_end
    and a.occurred_at >= b.scoring_start
    and a.occurred_at <  b.month_end
    and lower(f.email) in (${sqlStringList(emails)})`;

    const sql = `
with ${bounds},
win as (
${winSelect}
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
  win.transferred_out,
  win.ledger_type,
  win.attr_type,
  win.credit_id,
  win.net_client_credit_amount::float8 as members,
  win.hours_amount::float8 as sessions,
  life.lifetime_members,
  life.lifetime_sessions${creditJoin.enabled ? `,\n  win.credit_matched,\n  win.credit_business_date,\n  win.credit_occurred_date` : ""}${
      candidateSelectFromWin ? `,\n${candidateSelectFromWin}` : ""
    }
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
  (a.deleted_at is not null) as attribution_deleted,${transferredOut},
  l.type as ledger_type,
  a.type as attr_type,
  l.credit_id,
  l.net_client_credit_amount::float8 as members,
  l.hours_amount::float8 as sessions${
    creditJoin.enabled
      ? `,\n  ${creditMatchedExpr} as credit_matched${
          creditJoin.businessDateExpr
            ? `,\n  ${creditJoin.businessDateExpr} as credit_business_date`
            : `,\n  null::text as credit_business_date`
        }`
      : ""
  }${candidateSelect ? `,\n${candidateSelect}` : ""}
from sales_attribution.rep_scores_ledger_entries l
join sales_attribution.attributions a
  on a.id = l.attribution_id
join sales_attribution.flex_team_members f
  on f.manager_id = l.manager_id
 and f.deleted_at is null
${creditJoinSql}
cross join bounds b
where l.deleted_at is null
  and a.deleted_at is null
  and ${monthKeyExpr} >= b.month_start
  and ${monthKeyExpr} <  b.month_end
  and a.occurred_at >= b.scoring_start
  and a.occurred_at <  b.month_end
  and lower(f.email) in (${sqlStringList(emails)})
order by l.created_at asc, l.id asc;
`;

    const plainFallbackSql = `
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
  (a.deleted_at is not null) as attribution_deleted,${transferredOut},
  l.type as ledger_type,
  a.type as attr_type,
  l.credit_id,
  l.net_client_credit_amount::float8 as members,
  l.hours_amount::float8 as sessions${
    candidateColumns
      .filter((c) => c.table !== "credits")
      .map(({ alias, expr, type }) => {
        const asDay = MONTH_KEY_DATE_TYPES.has(type)
          ? type === "date"
            ? `${expr}::text`
            : `(${expr} at time zone '${tz}')::date::text`
          : `left((${expr})::text, 10)`;
        return `,\n  ${asDay} as "cand_${alias}"`;
      })
      .join("")
  }
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
    let creditJoinActive = creditJoin.enabled;
    try {
      rawRows = await runSupabaseSql<LedgerRow>(sql);
    } catch (enrichedErr: any) {
      console.error("get-live-actuals lifetime query failed, falling back", enrichedErr);
      try {
        rawRows = await runSupabaseSql<LedgerRow>(fallbackSql);
        lifetimeAvailable = false;
      } catch (fallbackErr: any) {
        if (!creditJoin.enabled) throw fallbackErr;
        console.error("get-live-actuals credit join failed, retrying without credits", fallbackErr);
        creditJoinActive = false;
        rawRows = await runSupabaseSql<LedgerRow>(plainFallbackSql);
        lifetimeAvailable = false;
      }
    }
    // Carry every candidate date onto the row so the journal, the payload and
    // the CSV all see the same values. Only keep values that look like a
    // calendar day — a name-matched integer column casting to "42" is noise.
    for (const row of rawRows) {
      const dates: Record<string, string> = {};
      for (const { alias } of candidateColumns) {
        if (!creditJoinActive && alias.startsWith("c_")) continue;
        const value = String((row as Record<string, unknown>)[`cand_${alias}`] ?? "").slice(0, 10);
        if (/^\d{4}-\d{2}-\d{2}$/.test(value)) dates[alias] = value;
      }
      row.month_key_candidates = dates;

      if (!creditJoinActive) {
        delete row.credit_matched;
        delete row.credit_business_date;
        continue;
      }
      // Normalize driver/boolean quirks from the SQL endpoint.
      const rawMatch = (row as Record<string, unknown>).credit_matched;
      if (rawMatch === true || rawMatch === "t" || rawMatch === "true" || rawMatch === 1) {
        row.credit_matched = true;
      } else if (rawMatch === false || rawMatch === "f" || rawMatch === "false" || rawMatch === 0) {
        row.credit_matched = false;
      } else if (rawMatch == null) {
        // Blank credit_id → unmatched when the join ran.
        row.credit_matched = false;
      }
      const biz = String(row.credit_business_date || "").slice(0, 10);
      row.credit_business_date = /^\d{4}-\d{2}-\d{2}$/.test(biz) ? biz : undefined;
    }

    // Safety: if the join ran but matched nothing on cancels that have a
    // credit_id, the ON clause is wrong — strip the signal so we don't wash
    // the whole tile to zero.
    if (creditJoinActive) {
      const cancelLike = rawRows.filter(
        (r) => (Number(r.members) || 0) < 0 || (Number(r.sessions) || 0) < 0
      );
      const withId = cancelLike.filter((r) => String(r.credit_id || "").trim());
      const matched = withId.filter((r) => r.credit_matched === true);
      if (withId.length > 0 && matched.length === 0) {
        console.warn(
          "get-live-actuals credit join matched 0 cancels with credit_id; disabling orphan-credit wash"
        );
        creditJoinActive = false;
        for (const row of rawRows) {
          delete row.credit_matched;
          delete row.credit_business_date;
        }
      }
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

    const orphanWash = reconciled.washed.filter((w) => w.reason === "orphan-credit");
    const creditMonthWash = reconciled.washed.filter((w) => w.reason === "credit-month");
    const rebookedCreditWash = reconciled.washed.filter((w) => w.reason === "rebooked-credit");
    const transferWashOnly = reconciled.washed.filter((w) => !w.reason || w.reason === "transfer");

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
          monthKeyColumn: "credits.occurred_at (cancels and credits)",
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
          ledgerColumns: schema.columns,
          schemaTables: schema.tables,
          attributionDateColumns: schema.attributionDateColumns,
          creditJoin: {
            enabled: creditJoin.enabled,
            active: creditJoinActive,
            idColumns: creditJoin.idColumns,
            dateColumns: creditJoin.dateColumns.map((c) => `${c.name}:${c.type}`),
            orphanWashed: {
              rows: orphanWash.length,
              members: orphanWash.reduce((s, w) => s + w.members, 0),
              sessions: orphanWash.reduce((s, w) => s + w.sessions, 0),
            },
            // Cancels the query itself windowed out because their credit
            // occurred in another month. Normally zero — the SQL window has
            // already applied the same rule — so a non-zero count means a
            // cached or fallback payload was corrected in the journal.
            creditMonthWashed: {
              rows: creditMonthWash.length,
              members: creditMonthWash.reduce((s, w) => s + w.members, 0),
              sessions: creditMonthWash.reduce((s, w) => s + w.sessions, 0),
            },
            // Positive lines re-booking a credit earned in another month. Like
            // the row above this is normally zero, because the query windows on
            // the credit's own day; a non-zero count means a cached or fallback
            // payload was corrected here instead.
            rebookedCreditWashed: {
              rows: rebookedCreditWash.length,
              members: rebookedCreditWash.reduce((s, w) => s + w.members, 0),
              sessions: rebookedCreditWash.reduce((s, w) => s + w.sessions, 0),
            },
          },
          // What each of those columns would score as the month key. The one
          // that keeps ~58 lines in July is the column the export windows on.
          monthKeyCandidates: summarizeMonthKeyCandidates(rows, monthYmd),
          // Ledger/attribution `type` breakdown — the remaining on-row lead.
          cancelTypes: summarizeCancelTypes(rows),
          // Whether the period-transfer wash matched anything. A rule that
          // ships, deploys and quietly matches nothing is how the cancel tile
          // stayed wrong across several releases — so this is reported next to
          // the number it is supposed to move.
          transferWash: {
            rows: transferWashOnly.length,
            members: transferWashOnly.reduce((s, w) => s + w.members, 0),
            sessions: transferWashOnly.reduce((s, w) => s + w.sessions, 0),
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
