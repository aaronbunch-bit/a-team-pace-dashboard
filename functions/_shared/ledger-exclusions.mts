import { getStore } from "@netlify/blobs";
import { teamTodayMonthKey } from "./time.mts";

/**
 * Pacer-side stand-in for a Supabase soft-delete.
 *
 * The dashboard has read-only access to `sales_attribution`, so a ledger entry
 * that should have been retired upstream (a superseded revision, a duplicate
 * attribution for one sale) can't be removed at the source. Admins can instead
 * exclude the offending ledger row id here, and `get-live-actuals` drops it
 * before any totalling — so pacing, Activity, contests, and Income Planning's
 * live MTD all agree.
 */
export const LEDGER_EXCLUSIONS_STORE = "ledger-exclusions";
export const LEDGER_EXCLUSIONS_KEY = "current";

/** Store + key prefix of the warm live-actuals response cache (see get-live-actuals). */
export const LIVE_ACTUALS_STORE = "actuals";
export const LIVE_ACTUALS_CACHE_KEY = "live-response-v1";

/**
 * Warm-cache key for one Chicago calendar month.
 *
 * Always includes the month. A bare `live-response-v1` key used to be shared by
 * whichever month was "current," so a July response warm at 11:59pm could be
 * served as August's live feed for up to a minute after midnight — July cancels
 * on August pacers.
 */
export function liveActualsCacheKey(month: string): string {
  const m = String(month || "").trim();
  if (/^\d{4}-\d{2}$/.test(m)) return `${LIVE_ACTUALS_CACHE_KEY}:${m}`;
  return `${LIVE_ACTUALS_CACHE_KEY}:${teamTodayMonthKey()}`;
}

export type LedgerExclusion = {
  ledgerId: string;
  clientId: string;
  repName: string;
  note: string;
  excludedBy: string;
  excludedAt: string;
};

function normalizeEntry(entry: any): LedgerExclusion | null {
  const ledgerId = String(entry?.ledgerId ?? entry ?? "").trim();
  if (!ledgerId) return null;
  return {
    ledgerId,
    clientId: String(entry?.clientId || "").trim(),
    repName: String(entry?.repName || "").trim(),
    note: String(entry?.note || "").trim(),
    excludedBy: String(entry?.excludedBy || "").trim(),
    excludedAt: String(entry?.excludedAt || "").trim(),
  };
}

export async function loadLedgerExclusionList(): Promise<LedgerExclusion[]> {
  try {
    const doc = await getStore(LEDGER_EXCLUSIONS_STORE).get(LEDGER_EXCLUSIONS_KEY, {
      type: "json",
    });
    const list = Array.isArray(doc) ? doc : (doc as any)?.ledgerIds;
    if (!Array.isArray(list)) return [];
    const out: LedgerExclusion[] = [];
    const seen = new Set<string>();
    for (const entry of list) {
      const normalized = normalizeEntry(entry);
      if (!normalized || seen.has(normalized.ledgerId)) continue;
      seen.add(normalized.ledgerId);
      out.push(normalized);
    }
    return out;
  } catch {
    return [];
  }
}

export async function loadLedgerExclusionIds(): Promise<Set<string>> {
  const list = await loadLedgerExclusionList();
  return new Set(list.map((entry) => entry.ledgerId));
}

export async function saveLedgerExclusionList(list: LedgerExclusion[]): Promise<void> {
  await getStore(LEDGER_EXCLUSIONS_STORE).setJSON(LEDGER_EXCLUSIONS_KEY, list);
}

/**
 * Drop the warm live-actuals cache so an exclusion takes effect on the next
 * poll instead of up to a minute later.
 */
export async function invalidateLiveActualsCache(): Promise<void> {
  const store = getStore(LIVE_ACTUALS_STORE);
  const live = teamTodayMonthKey();
  const [y, m] = live.split("-").map(Number);
  const prior = m === 1
    ? `${y - 1}-12`
    : `${y}-${String(m - 1).padStart(2, "0")}`;
  const keys = [
    LIVE_ACTUALS_CACHE_KEY, // legacy unscoped key
    liveActualsCacheKey(live),
    liveActualsCacheKey(prior),
  ];
  await Promise.all(keys.map((key) => store.delete(key).catch(() => {})));
}
