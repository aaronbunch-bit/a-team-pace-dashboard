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
// Month-window contract (sale occurred_at OR cancel ledger created_at) — keep
// SQL below aligned with functions/_shared/live-month-credit.mts.
export {
  ledgerRowInLiveMonth,
  liveMonthCreditAtMs,
} from "./_shared/live-month-credit.mts";

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
};

/** A ledger row the pacer removed before totalling, and why. */
type SuppressedRow = {
  ledgerId: string;
  attributionId: string;
  clientId: string;
  repName: string;
  members: number;
  sessions: number;
  date: string;
  reason: "superseded-revision" | "admin-excluded";
  /** Ledger row that was kept in place of a superseded revision. */
  supersededBy?: string;
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

function rowSortKey(row: LedgerRow): string {
  // created_at first so a later revision wins; ledger id breaks exact ties.
  return `${String(row.ledger_created_at || "")}|${String(row.ledger_id || "")}`;
}

/**
 * Collapse duplicate credit before totalling.
 *
 * Two live ledger rows sharing one attribution + manager are a revision that
 * was never soft-deleted upstream (the 100%-then-corrected-to-50% case), not
 * two sales — so the newest row wins and the rest are suppressed.
 *
 * Two *different* attributions for the same client are deliberately left alone:
 * that shape is also how a legitimate second purchase or a cancel/rebook pair
 * looks, and collapsing it would erase real revenue. Those are flagged for
 * human review instead, and an admin can exclude a specific ledger id.
 */
function reconcileLedgerRows(
  rows: LedgerRow[],
  emailToDisplay: Record<string, string>,
  exclusions: Set<string>
): { rows: LedgerRow[]; suppressed: SuppressedRow[]; flagged: FlaggedPair[] } {
  const suppressed: SuppressedRow[] = [];
  const displayFor = (row: LedgerRow) => {
    const email = safeEmail(row.email);
    return (email && emailToDisplay[email]) || String(row.manager_name || "Unknown rep");
  };
  const describe = (
    row: LedgerRow,
    reason: SuppressedRow["reason"],
    supersededBy?: string
  ): SuppressedRow => ({
    ledgerId: String(row.ledger_id || ""),
    attributionId: String(row.attribution_id || ""),
    clientId: String(row.client_id || ""),
    repName: displayFor(row),
    members: Number(row.members) || 0,
    sessions: Number(row.sessions) || 0,
    date: String(row.attribution_date || "").slice(0, 10),
    reason,
    ...(supersededBy ? { supersededBy } : {}),
  });

  const afterExclusions: LedgerRow[] = [];
  for (const row of rows) {
    const ledgerId = String(row.ledger_id || "").trim();
    if (ledgerId && exclusions.has(ledgerId)) {
      suppressed.push(describe(row, "admin-excluded"));
      continue;
    }
    afterExclusions.push(row);
  }

  // Revision collapse — keyed on attribution + manager, never on client alone.
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

  const kept: LedgerRow[] = [...unkeyed];
  for (const bucket of byAttribution.values()) {
    if (bucket.length === 1) {
      kept.push(bucket[0]);
      continue;
    }
    const ordered = [...bucket].sort((a, b) => rowSortKey(a).localeCompare(rowSortKey(b)));
    const winner = ordered[ordered.length - 1];
    kept.push(winner);
    for (const loser of ordered.slice(0, -1)) {
      suppressed.push(describe(loser, "superseded-revision", String(winner.ledger_id || "")));
    }
  }

  // Flag-only pass: same client + rep credited through separate attributions.
  const byClientRep = new Map<string, LedgerRow[]>();
  for (const row of kept) {
    if ((Number(row.members) || 0) <= 0 && (Number(row.sessions) || 0) <= 0) continue;
    const clientId = String(row.client_id || "").trim();
    if (!clientId) continue;
    const key = `${clientId}|${displayFor(row)}`;
    const bucket = byClientRep.get(key);
    if (bucket) bucket.push(row);
    else byClientRep.set(key, [row]);
  }
  const flagged: FlaggedPair[] = [];
  for (const bucket of byClientRep.values()) {
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

  return { rows: kept, suppressed, flagged };
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
    if (m < 0) bucket.membersCancels += m;
    if (s < 0) bucket.sessionsCancels += s;
    const occurredAt = String(row.occurred_at || "").trim();
    const ledgerId = String(row.ledger_id || "").trim();
    const attributionId = String(row.attribution_id || "").trim();
    bucket.items.push({
      clientId: String(row.client_id || "").trim(),
      members: m,
      sessions: s,
      date: d,
      ...(occurredAt ? { occurredAt } : {}),
      ...(ledgerId ? { ledgerId } : {}),
      ...(attributionId ? { attributionId } : {}),
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
    | { suppressed?: unknown[]; flagged?: unknown[] }
    | undefined;
  if (!integrity) return;
  payload.ledgerIntegrity = {
    suppressedCount: Array.isArray(integrity.suppressed) ? integrity.suppressed.length : 0,
    flaggedCount: Array.isArray(integrity.flagged) ? integrity.flagged.length : 0,
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
    // Month window rules:
    // 1) Any credit whose attribution occurred_at is in the month (sales +
    //    same-month revisions/cancels).
    // 2) Cancels that *hit* this month even when the original sale was earlier:
    //    negative ledger rows whose ledger created_at falls in the month.
    //    Without (2), prior-month sale cancels never reduce MTD — which is how
    //    live drifted above the July CSV cancel set.
    //
    // Display/as-of date for (2) uses ledger created_at (when the cancel hit),
    // not the original sale's occurred_at.
    const tz = TEAM_TIME_ZONE.replace(/'/g, "''");
    const sql = `
with month_bounds as (
  select
    (date_trunc('month', (now() at time zone '${tz}')) at time zone '${tz}') as month_start,
    ((date_trunc('month', (now() at time zone '${tz}')) + interval '1 month') at time zone '${tz}') as month_end
)
select
  lower(f.email) as email,
  f.name as manager_name,
  a.client_id,
  l.id::text as ledger_id,
  a.id::text as attribution_id,
  l.manager_id::text as manager_id,
  l.created_at::text as ledger_created_at,
  case
    when a.occurred_at >= mb.month_start and a.occurred_at < mb.month_end
      then (a.occurred_at at time zone '${tz}')::date::text
    else (l.created_at at time zone '${tz}')::date::text
  end as attribution_date,
  case
    when a.occurred_at >= mb.month_start and a.occurred_at < mb.month_end
      then (a.occurred_at at time zone '${tz}')::text
    else (l.created_at at time zone '${tz}')::text
  end as occurred_at,
  l.net_client_credit_amount::float8 as members,
  l.hours_amount::float8 as sessions
from sales_attribution.rep_scores_ledger_entries l
join sales_attribution.attributions a
  on a.id = l.attribution_id
join sales_attribution.flex_team_members f
  on f.manager_id = l.manager_id
 and f.deleted_at is null
cross join month_bounds mb
where l.deleted_at is null
  and a.deleted_at is null
  and (
    (a.occurred_at >= mb.month_start and a.occurred_at < mb.month_end)
    or (
      l.created_at >= mb.month_start
      and l.created_at < mb.month_end
      and (l.net_client_credit_amount < 0 or l.hours_amount < 0)
    )
  )
  and lower(f.email) in (${sqlStringList(emails)})
order by attribution_date asc, l.id asc;
`;

    const rawRows = await runSupabaseSql<LedgerRow>(sql);
    const exclusions = await loadLedgerExclusionIds();
    const reconciled = reconcileLedgerRows(rawRows, emailToDisplay, exclusions);
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
        excludedIds: [...exclusions],
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
