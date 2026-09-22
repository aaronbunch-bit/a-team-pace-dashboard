import type { Context, Config } from "@netlify/functions";
import { getIdentityUser } from "./_shared/identity.mts";
import { requireAdmin } from "./_shared/access.mts";
import { invalidateLiveActualsCache } from "./_shared/ledger-exclusions.mts";
import { loadValidRepDisplays } from "./_shared/roster.mts";
import {
  loadUnmatchedReviewList,
  saveUnmatchedReviewList,
  type UnmatchedReviewDecision,
} from "./_shared/unmatched-reviews.mts";

/**
 * Approve, deny, or reopen one ledger record that could not be matched by
 * email. Approval assigns it to a real pacer display; denial keeps it excluded.
 * Full-admin authorization is resolved server-side from the shared admin list.
 */
export default async (req: Request, context: Context) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const user = await getIdentityUser(req, context);
  const denied = await requireAdmin(user);
  if (denied) return denied;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid request body" }, 400);
  }

  const reviewKey = String(body?.reviewKey || "").trim();
  if (!reviewKey || reviewKey.length > 1_000) {
    return json({ error: "Missing or invalid reviewKey" }, 400);
  }

  const action = String(body?.action || "").trim().toLowerCase();
  if (!["approve", "deny", "reopen"].includes(action)) {
    return json({ error: "action must be 'approve', 'deny', or 'reopen'" }, 400);
  }

  const current = await loadUnmatchedReviewList();
  let next = current.filter((entry) => entry.reviewKey !== reviewKey);

  if (action !== "reopen") {
    const repDisplay = String(body?.repDisplay || "").trim();
    if (action === "approve") {
      const validDisplays = await loadValidRepDisplays();
      if (!repDisplay || !validDisplays.has(repDisplay)) {
        return json({ error: "Choose a current roster rep before approving" }, 400);
      }
    }
    const decision: UnmatchedReviewDecision = {
      reviewKey,
      status: action === "approve" ? "approved" : "denied",
      ...(action === "approve" ? { repDisplay } : {}),
      reviewedBy: String(user?.email || "").trim().toLowerCase(),
      reviewedAt: new Date().toISOString(),
    };
    next = [...next, decision];
  }

  await saveUnmatchedReviewList(next);
  await invalidateLiveActualsCache();

  return json({ ok: true, action, reviewKey });
};

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export const config: Config = {
  path: "/api/ledger/unmatched-review",
};
