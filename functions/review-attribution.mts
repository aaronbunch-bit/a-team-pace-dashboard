import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { getIdentityUser } from "./_shared/identity.mts";
import { requireAdmin } from "./_shared/access.mts";

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

  const { id, action } = body || {};
  if (!id || (action !== "approve" && action !== "reject")) {
    return new Response(JSON.stringify({ error: "Missing id or invalid action" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const reviewComment = String(body?.comment || body?.reviewComment || "").trim();
  if (action === "reject" && !reviewComment) {
    return new Response(JSON.stringify({ error: "A comment is required when rejecting a request" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const store = getStore("manual-attributions");
  const record: any = await store.get(id, { type: "json" });
  if (!record) {
    return new Response(JSON.stringify({ error: "Request not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  const nextStatus = action === "approve" ? "approved" : "rejected";

  // Idempotent: re-approving / re-rejecting an already-settled request should
  // not look like a failure (Blob list lag used to make the UI ask twice).
  if (record.status === nextStatus) {
    return new Response(JSON.stringify({ ok: true, record, already: true }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }

  if (record.status !== "pending") {
    return new Response(
      JSON.stringify({
        error: `This request is already ${record.status}. Refresh and try again.`,
      }),
      { status: 409, headers: { "Content-Type": "application/json" } }
    );
  }

  record.status = nextStatus;
  record.reviewedAt = new Date().toISOString();
  record.reviewedBy = user.email;
  if (action === "reject") {
    record.reviewComment = reviewComment;
  } else if (reviewComment) {
    record.reviewComment = reviewComment;
  } else {
    // Clear any prior reject note if somehow re-opened (shouldn't happen).
    delete record.reviewComment;
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
