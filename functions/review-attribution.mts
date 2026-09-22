import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { getIdentityUser } from "./_shared/identity.mts";
import { requireAdmin } from "./_shared/access.mts";

const ACTIONS = new Set(["approve", "reject", "reopen"]);

/**
 * Admin decision API:
 *  - approve  → approved (note required)
 *  - reject   → rejected (note required)
 *  - reopen   → pending  (note optional; clears prior decision)
 * Allowed from any current status (pending / approved / rejected) so admins
 * can flip decisions or send a settled request back to the queue.
 */
export default async (req: Request, context: Context) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
  }

  const user = await getIdentityUser(req, context);
  const denied = await requireAdmin(user);
  if (denied) return denied;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid request body" }), { status: 400 });
  }

  const id = String(body?.id || "").trim();
  const action = String(body?.action || "").trim();
  if (!id || !ACTIONS.has(action)) {
    return new Response(JSON.stringify({ error: "Missing id or invalid action" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const reviewComment = String(body?.comment || body?.reviewComment || "").trim();
  if ((action === "approve" || action === "reject") && !reviewComment) {
    return new Response(
      JSON.stringify({
        error:
          action === "approve"
            ? "A note is required when approving a request"
            : "A note is required when rejecting a request",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const store = getStore("manual-attributions");
  const record: any = await store.get(id, { type: "json" });
  if (!record) {
    return new Response(JSON.stringify({ error: "Request not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  const nextStatus =
    action === "approve" ? "approved" : action === "reject" ? "rejected" : "pending";

  // Idempotent: same decision again is OK (Blob list lag / double click).
  if (record.status === nextStatus && action !== "reopen") {
    if (reviewComment && record.reviewComment !== reviewComment) {
      record.reviewComment = reviewComment;
      record.reviewedAt = new Date().toISOString();
      record.reviewedBy = user.email;
      await store.setJSON(id, record);
    }
    return new Response(JSON.stringify({ ok: true, record, already: true }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }

  const prevStatus = String(record.status || "pending");
  record.status = nextStatus;
  record.decisionHistory = Array.isArray(record.decisionHistory) ? record.decisionHistory : [];
  record.decisionHistory.push({
    from: prevStatus,
    to: nextStatus,
    action,
    by: user.email,
    at: new Date().toISOString(),
    note: reviewComment || null,
  });

  if (action === "reopen") {
    record.reviewedAt = null;
    record.reviewedBy = null;
    if (reviewComment) record.reviewComment = reviewComment;
    else delete record.reviewComment;
    record.reopenedAt = new Date().toISOString();
    record.reopenedBy = user.email;
  } else {
    record.reviewedAt = new Date().toISOString();
    record.reviewedBy = user.email;
    record.reviewComment = reviewComment;
  }

  await store.setJSON(id, record);

  return new Response(JSON.stringify({ ok: true, record }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
};

export const config: Config = {
  path: "/api/attributions/review",
};
