import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { getIdentityUser } from "./_shared/identity.mts";
import { resolveAccess } from "./_shared/access.mts";
import { resolveRepNameFromEmail } from "./_shared/roster.mts";
import { membersValidationError, normalizeAttrMembers } from "./_shared/attribution.mts";

function looksLikeUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Edit a Manual Attribution adjustment request.
 *  - Pending / rejected: owner, full admin, or Sales Coach
 *  - Approved: full admins only (credit totals recompute from the updated record)
 * Rejected requests return to pending so they can be re-reviewed.
 */
export default async (req: Request, context: Context) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
  }

  const user = await getIdentityUser(req, context);
  if (!user?.email) {
    return new Response(JSON.stringify({ error: "Not signed in" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const access = await resolveAccess(user.email);
  if (!access) {
    return new Response(JSON.stringify({ error: "Not signed in" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid request body" }), { status: 400 });
  }

  const id = String(body?.id || "").trim();
  if (!id) {
    return new Response(JSON.stringify({ error: "Missing id" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const clientLink = String(body?.clientLink || "").trim();
  const contact = body?.contact != null ? String(body.contact).trim() : "";
  const adjustmentReason = String(body?.adjustmentReason || body?.reason || "").trim();
  const comments = String(body?.comments || "").trim();
  const membersNum = normalizeAttrMembers(body?.members);
  const sessionsNum = Number(body?.sessions) || 0;

  const membersErr = membersValidationError(membersNum);
  if (membersErr) {
    return new Response(JSON.stringify({ error: membersErr }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (!contact) {
    return new Response(JSON.stringify({ error: "Phone or email is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (!adjustmentReason) {
    return new Response(JSON.stringify({ error: "Adjustment reason is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (!comments) {
    return new Response(JSON.stringify({ error: "Comments are required" }), {
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

  const status = String(record.status || "");
  const isApproved = status === "approved";
  const isPendingOrRejected = status === "pending" || status === "rejected";

  if (!isApproved && !isPendingOrRejected) {
    return new Response(JSON.stringify({ error: `Can't edit a request with status ${status || "unknown"}` }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  const email = access.email;
  const ownName = await resolveRepNameFromEmail(email);
  const isOwner =
    String(record.repEmail || "").toLowerCase() === email ||
    (!!ownName && String(record.repName || "") === ownName);

  if (isApproved) {
    if (!access.isFullAdmin) {
      return new Response(
        JSON.stringify({ error: "Only admins can edit approved Manual Attribution requests" }),
        { status: 403, headers: { "Content-Type": "application/json" } }
      );
    }
  } else if (!access.canViewTeam && !isOwner) {
    return new Response(
      JSON.stringify({ error: "You can only edit your own Manual Attribution requests" }),
      { status: 403, headers: { "Content-Type": "application/json" } }
    );
  }

  // Cancel-conversion rows may only have a clientId; keep that path usable.
  const hasClientId = !!String(record.clientId || "").trim();
  if (clientLink) {
    if (!looksLikeUrl(clientLink)) {
      return new Response(JSON.stringify({ error: "Client page link must be a valid http(s) URL" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    record.clientLink = clientLink;
  } else if (!hasClientId) {
    return new Response(JSON.stringify({ error: "Client page link is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const wasRejected = status === "rejected";

  record.contact = contact;
  record.members = membersNum;
  record.sessions = sessionsNum;
  record.adjustmentReason = adjustmentReason;
  // Keep legacy `reason` in sync for cancel-conversion era rows.
  if (record.reason != null || record.source === "cancel-conversion") {
    record.reason = adjustmentReason;
  }
  record.comments = comments;
  record.updatedAt = new Date().toISOString();
  record.updatedBy = email;

  if (wasRejected) {
    // Fix-and-resubmit: send back through the approvals queue.
    record.status = "pending";
    record.reviewedAt = null;
    record.reviewedBy = null;
    delete record.reviewComment;
    record.resubmittedAt = record.updatedAt;
  }

  await store.setJSON(id, record);

  return new Response(
    JSON.stringify({
      ok: true,
      record,
      resubmitted: wasRejected,
      approvedEdited: isApproved,
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    }
  );
};

export const config: Config = {
  path: "/api/attributions/update",
};
