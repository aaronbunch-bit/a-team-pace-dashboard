import { getStore } from "@netlify/blobs";

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

/** Store + key of the warm live-actuals response cache (see get-live-actuals). */
export const LIVE_ACTUALS_STORE = "actuals";
export const LIVE_ACTUALS_CACHE_KEY = "live-response-v1";

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
 * poll instead of up to 20s later.
 */
export async function invalidateLiveActualsCache(): Promise<void> {
  try {
    await getStore(LIVE_ACTUALS_STORE).delete(LIVE_ACTUALS_CACHE_KEY);
  } catch {
    // Best effort — the cache expires on its own shortly after.
  }
}
