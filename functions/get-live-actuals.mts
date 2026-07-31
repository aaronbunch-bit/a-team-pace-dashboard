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
const LIVE_CACHE_TTL_MS = 20_000;
const LIVE_CACHE_KEY = LIVE_ACTUALS_CACHE_KEY;

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
  reason: "admin-excluded";
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
 * The ledger row's own business date, in the order the rep-scores export is
 * most likely to name it.
 *
 * A ledger line carries a business date that is not the moment the row was
 * written: the July export holds cancel lines dated 7/6, 7/14 and 7/15 that did
 * not exist yet when the 7/26 export was pulled, so upstream backfills lines
 * with an earlier date on them. That business date is the export's
 * `attribution_date` column and it is what decides the month a line lands in.
 * Row creation time is the wrong key in both directions — a line written in
 * July for June business belongs to June.
 */
const LEDGER_MONTH_KEY_CANDIDATES = [
  "attribution_date",
  "effective_date",
  "business_date",
  "entry_date",
  "scored_at",
  "scored_date",
  "occurred_at",
  "posted_at",
  "transaction_date",
  "credited_at",
];

type MonthKey = { column: string; dataType: string; discovered: boolean };

const CREATED_AT_MONTH_KEY: MonthKey = {
  column: "created_at",
  dataType: "timestamp with time zone",
  discovered: false,
};

/** Picked once per warm instance — the ledger's shape doesn't change per poll. */
let cachedMonthKey: MonthKey | null = null;

export function pickMonthKey(columns: { column_name: string; data_type: string }[]): MonthKey | null {
  const byName = new Map(columns.map((c) => [String(c.column_name), String(c.data_type)]));
  for (const column of LEDGER_MONTH_KEY_CANDIDATES) {
    const dataType = byName.get(column);
    if (dataType) return { column, dataType, discovered: true };
  }
  return null;
}

/**
 * Ask the database which date column the ledger actually has rather than
 * hard-coding a name that may not exist. A miss falls back to created_at (the
 * previous behaviour) and is reported in the payload instead of failing the
 * request.
 */
async function ledgerMonthKey(): Promise<MonthKey> {
  if (cachedMonthKey) return cachedMonthKey;
  try {
    const columns = await runSupabaseSql<{ column_name: string; data_type: string }>(`
select column_name, data_type
from information_schema.columns
where table_schema = 'sales_attribution'
  and table_name = 'rep_scores_ledger_entries'
  and data_type in ('date', 'timestamp with time zone', 'timestamp without time zone');
`);
    const picked = pickMonthKey(columns || []);
    if (picked) {
      cachedMonthKey = picked;
      return picked;
    }
  } catch {
    // Introspection is best-effort; retry on the next cold-ish request.
  }
  return CREATED_AT_MONTH_KEY;
}

/** The month key as a Chicago calendar day. */
export function monthKeyDayExpr(key: MonthKey, tz: string): string {
  const col = `l.${key.column}`;
  if (key.dataType === "date") return col;
  if (key.dataType === "timestamp without time zone") {
    return `((${col} at time zone 'UTC') at time zone '${tz}')::date`;
  }
  return `(${col} at time zone '${tz}')::date`;
}

/** The month key as a readable Chicago timestamp for the row detail views. */
export function monthKeyStampExpr(key: MonthKey, tz: string): string {
  const col = `l.${key.column}`;
  if (key.dataType === "date") return `${col}::text`;
  if (key.dataType === "timestamp without time zone") {
    return `((${col} at time zone 'UTC') at time zone '${tz}')::text`;
  }
  return `(${col} at time zone '${tz}')::text`;
}

/**
 * Month window as a bare comparison on the column itself — the bounds do the
 * timezone work — so the ledger's index on that column can still be used.
 * Bounds come from the `bounds` CTE below.
 */
export function monthKeyWindowSql(key: MonthKey): string {
  const col = `l.${key.column}`;
  if (key.dataType === "date") {
    return `${col} >= b.month_start_day\n  and ${col} <  b.next_month_day`;
  }
  if (key.dataType === "timestamp without time zone") {
    return `${col} >= (b.month_start at time zone 'UTC')\n  and ${col} <  (b.month_end at time zone 'UTC')`;
  }
  return `${col} >= b.month_start\n  and ${col} <  b.month_end`;
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
} {
  const suppressed: SuppressedRow[] = [];
  const displayFor = (row: LedgerRow) => {
    const email = safeEmail(row.email);
    return (email && emailToDisplay[email]) || String(row.manager_name || "Unknown rep");
  };

  const afterExclusions: LedgerRow[] = [];
  for (const row of rows) {
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
    const cancelLines = classified.filter((r) => r.kind === "cancel");
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

    if (classified.length > 1) {
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

  return { rows: kept, suppressed, flagged, netted };
}

type RowSummary = { rows: number; members: number; sessions: number; clientIds: string[] };

function summarizeRows(rows: LedgerRow[]): RowSummary {
  return {
    rows: rows.length,
    members: rows.reduce((sum, r) => sum + (Number(r.members) || 0), 0),
    sessions: rows.reduce((sum, r) => sum + (Number(r.sessions) || 0), 0),
    // Enough to look a few up by hand without shipping the whole set.
    clientIds: [...new Set(rows.map((r) => String(r.client_id || "").trim()).filter(Boolean))].slice(0, 25),
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
  const digest = (doc: any) => {
    const per = (doc && doc.perRep) || {};
    return `${doc?.asOf || ""}|` + Object.keys(per).sort().map((k) => {
      const r = per[k] || {};
      return `${k}:${Number(r.members) || 0}:${Number(r.sessions) || 0}:${Array.isArray(r.items) ? r.items.length : 0}`;
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

  try {
    const cacheStore = getStore("actuals");
    if (!bypassCache) {
      try {
        const cached = (await cacheStore.get(LIVE_CACHE_KEY, { type: "json" })) as LiveCacheDoc | null;
        if (cached?.payload && Number(cached.fetchedAtMs) > 0) {
          const age = Date.now() - Number(cached.fetchedAtMs);
          if (age >= 0 && age < LIVE_CACHE_TTL_MS) {
            const payload = { ...cached.payload, cacheHit: true, cacheAgeMs: age };
            if (compact && payload.actuals) {
              payload.actuals = stripItemsForCompact(payload.actuals as any);
              delete payload.prelim;
              stripIntegrityForCompact(payload);
            }
            return new Response(JSON.stringify(payload), {
              status: 200,
              headers: {
                "Content-Type": "application/json",
                "Cache-Control": "private, max-age=15",
              },
            });
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
    // One condition, the same one the rep-scores export applies: the ledger
    // line's own business date falls in this month. Everything else we tried is
    // measurably wrong against the July export's -50.5 members / -336 sessions
    // of cancels (the manual pacer reads 51.5 / 326):
    //
    // - attributions.occurred_at is the sale's date and stays there when the
    //   sale is cancelled, so it only ever finds cancels of *this month's*
    //   sales: -14.0 / -108 in the export, which is exactly what the tiles read.
    // - l.created_at is when the row was written, which is not its business
    //   date — the export carries lines dated 7/6, 7/14 and 7/15 that did not
    //   exist on 7/26. Keying on it charges July for June-dated lines written in
    //   July and the tiles overshoot to -86.5.
    const tz = TEAM_TIME_ZONE.replace(/'/g, "''");
    const monthKey = await ledgerMonthKey();
    const monthYmd = teamTodayYmd().slice(0, 7);
    const ledgerDay = monthKeyDayExpr(monthKey, tz);
    const sql = `
with bounds as (
  select
    (date_trunc('month', (now() at time zone '${tz}')) at time zone '${tz}') as month_start,
    ((date_trunc('month', (now() at time zone '${tz}')) + interval '1 month') at time zone '${tz}') as month_end,
    date_trunc('month', (now() at time zone '${tz}'))::date as month_start_day,
    (date_trunc('month', (now() at time zone '${tz}')) + interval '1 month')::date as next_month_day
)
select
  lower(f.email) as email,
  f.name as manager_name,
  a.client_id,
  l.id::text as ledger_id,
  a.id::text as attribution_id,
  l.manager_id::text as manager_id,
  l.created_at::text as ledger_created_at,
  ${ledgerDay}::text as attribution_date,
  ${monthKeyStampExpr(monthKey, tz)} as occurred_at,
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
  and ${monthKeyWindowSql(monthKey)}
  and lower(f.email) in (${sqlStringList(emails)})
order by l.${monthKey.column} asc, l.id asc;
`;

    const rawRows = await runSupabaseSql<LedgerRow>(sql);
    // The export lists live attributions, so a line whose attribution upstream
    // soft-deleted is held back rather than counted — but it is reported, since
    // silently dropping a cancel is how tiles drift from the export.
    const liveRows = rawRows.filter((row) => !row.attribution_deleted);
    const deletedAttribution = summarizeRows(rawRows.filter((row) => !!row.attribution_deleted));
    const exclusions = await loadLedgerExclusionIds();
    const reconciled = netLedgerJournal(liveRows, emailToDisplay, exclusions);
    const rows = reconciled.rows;
    const built = buildActuals(rows, emailToDisplay);
    const actuals = { asOf: built.asOf, perRep: built.perRep };
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
        // Everything needed to reconcile the cancel tiles against a rep-scores
        // export without another round of guessing at the window.
        window: {
          monthKeyColumn: monthKey.column,
          monthKeyDiscovered: monthKey.discovered,
          month: monthYmd,
          deletedAttribution,
          cancelsBySaleMonth: summarizeCancelsBySaleMonth(rows, monthYmd),
        },
      },
      actuals,
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

    const responsePayload = { ...fullPayload };
    if (compact) {
      responsePayload.actuals = stripItemsForCompact(actuals);
      delete responsePayload.prelim;
      stripIntegrityForCompact(responsePayload);
    }

    return new Response(JSON.stringify(responsePayload), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "private, max-age=15",
      },
    });
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
