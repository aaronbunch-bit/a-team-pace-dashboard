import { getStore } from "@netlify/blobs";

export const UNMATCHED_REVIEWS_STORE = "unmatched-ledger-reviews";
export const UNMATCHED_REVIEWS_KEY = "current";

export type UnmatchedReviewDecision = {
  reviewKey: string;
  status: "approved" | "denied";
  repDisplay?: string;
  reviewedBy: string;
  reviewedAt: string;
};

function normalizeDecision(value: any): UnmatchedReviewDecision | null {
  const reviewKey = String(value?.reviewKey || "").trim();
  const status = String(value?.status || "").trim().toLowerCase();
  const repDisplay = String(value?.repDisplay || "").trim();
  if (!reviewKey || (status !== "approved" && status !== "denied")) return null;
  if (status === "approved" && !repDisplay) return null;
  return {
    reviewKey,
    status,
    ...(status === "approved" ? { repDisplay } : {}),
    reviewedBy: String(value?.reviewedBy || "").trim().toLowerCase(),
    reviewedAt: String(value?.reviewedAt || "").trim(),
  };
}

export function normalizeUnmatchedReviewList(value: unknown): UnmatchedReviewDecision[] {
  if (!Array.isArray(value)) return [];
  const byKey = new Map<string, UnmatchedReviewDecision>();
  for (const raw of value) {
    const decision = normalizeDecision(raw);
    if (decision) byKey.set(decision.reviewKey, decision);
  }
  return [...byKey.values()];
}

export async function loadUnmatchedReviewList(): Promise<UnmatchedReviewDecision[]> {
  try {
    const value = await getStore(UNMATCHED_REVIEWS_STORE).get(UNMATCHED_REVIEWS_KEY, {
      type: "json",
    });
    return normalizeUnmatchedReviewList(value);
  } catch {
    return [];
  }
}

export async function saveUnmatchedReviewList(
  decisions: UnmatchedReviewDecision[]
): Promise<void> {
  await getStore(UNMATCHED_REVIEWS_STORE).setJSON(
    UNMATCHED_REVIEWS_KEY,
    normalizeUnmatchedReviewList(decisions)
  );
}

/**
 * Stable identity for one post-journal ledger record.
 *
 * Normal rows have a Supabase ledger id. The fallback keeps a malformed row
 * reviewable instead of silently dropping it when that id is absent.
 */
export function unmatchedReviewKey(row: {
  ledger_id?: unknown;
  attribution_id?: unknown;
  manager_id?: unknown;
  manager_name?: unknown;
  client_id?: unknown;
  attribution_date?: unknown;
  members?: unknown;
  sessions?: unknown;
}): string {
  const ledgerId = String(row.ledger_id || "").trim();
  if (ledgerId) return `ledger:${ledgerId}`;
  return `row:${JSON.stringify([
    String(row.attribution_id || "").trim(),
    String(row.manager_id || "").trim(),
    String(row.manager_name || "").trim(),
    String(row.client_id || "").trim(),
    String(row.attribution_date || "").slice(0, 10),
    Number(row.members) || 0,
    Number(row.sessions) || 0,
  ])}`;
}
