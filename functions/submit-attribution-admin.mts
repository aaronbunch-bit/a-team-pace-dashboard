import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { getIdentityUser } from "./_shared/identity.mts";
import { resolveAccess } from "./_shared/access.mts";
import { loadValidRepDisplays, resolveEmailFromRepDisplay } from "./_shared/roster.mts";
import { teamTodayYmd } from "./_shared/time.mts";
import { membersValidationError, normalizeAttrMembers } from "./_shared/attribution.mts";

// Two elevated submit paths share this endpoint:
//   1) source: "cancel-conversion" — full admins only (Team Details cancel move)
//   2) source: "on-behalf" — full admins OR Sales Coaches, picking a roster rep
//      so they can submit Manual Attribution for someone else
// Regular self-submit stays on submit-attribution.mts (caller = rep).
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

  const source = String(body?.source || "cancel-conversion");
  const isOnBehalf = source === "on-behalf";

  if (isOnBehalf) {
    if (!access.isFullAdmin && !access.isCoach) {
      return new Response(
        JSON.stringify({
          error: `Admin or Sales Coach access required. Signed in as ${access.email}.`,
        }),
        { status: 403, headers: { "Content-Type": "application/json" } }
      );
    }
  } else if (!access.isFullAdmin) {
    return new Response(
      JSON.stringify({
        error: `Admin access required. Signed in as ${access.email}.`,
      }),
      { status: 403, headers: { "Content-Type": "application/json" } }
    );
  }

  const { repName, members, sessions } = body || {};
  const membersNum = normalizeAttrMembers(members);
  const sessionsNum = Number(sessions) || 0;
  const membersErr = membersValidationError(members);
  if (membersErr) {
    return new Response(JSON.stringify({ error: membersErr }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  const validReps = await loadValidRepDisplays();
  if (!repName || !validReps.has(String(repName))) {
    return new Response(JSON.stringify({ error: "repName must be a current rep on the roster" }), {
      status: 400,
    });
  }
  if (!membersNum && !sessionsNum) {
    return new Response(
      JSON.stringify({ error: "Missing required fields (members or sessions)" }),
      { status: 400 }
    );
  }

  const initiatedBy = String(user.email).toLowerCase();
  const repEmail = await resolveEmailFromRepDisplay(String(repName));

  if (isOnBehalf) {
    const { clientLink, contact, adjustmentReason, comments } = body || {};
    if (!clientLink || !adjustmentReason || !comments) {
      return new Response(
        JSON.stringify({
          error: "Missing required fields (clientLink, adjustmentReason, comments)",
        }),
        { status: 400 }
      );
    }
    const record = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      repEmail,
      repName: String(repName),
      clientLink: String(clientLink).trim(),
      contact: contact ? String(contact).trim() : "",
      members: membersNum,
      sessions: sessionsNum,
      adjustmentReason: String(adjustmentReason).trim(),
      comments: String(comments).trim(),
      saleDate: teamTodayYmd(),
      status: "pending",
      submittedAt: new Date().toISOString(),
      reviewedAt: null as string | null,
      reviewedBy: null as string | null,
      submittedByAdmin: access.isFullAdmin,
      submittedOnBehalf: true,
      initiatedBy,
      source: "on-behalf",
    };
    const store = getStore("manual-attributions");
    await store.setJSON(record.id, record);
    return new Response(JSON.stringify({ ok: true, record }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Cancel → Manual Attribution conversion (legacy field names).
  const { clientId, saleDate, reason, comments } = body || {};
  if (!clientId || !saleDate || !reason || !comments) {
    return new Response(
      JSON.stringify({
        error: "Missing required fields (clientId, members or sessions, saleDate, reason, comments)",
      }),
      { status: 400 }
    );
  }

  const record = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    repEmail,
    repName: String(repName),
    clientId: String(clientId).trim(),
    members: membersNum,
    sessions: sessionsNum,
    saleDate: String(saleDate).slice(0, 10),
    reason: String(reason).trim(),
    comments: String(comments).trim(),
    status: "pending",
    submittedAt: new Date().toISOString(),
    reviewedAt: null as string | null,
    reviewedBy: null as string | null,
    submittedByAdmin: true,
    initiatedBy,
    source: "cancel-conversion",
  };

  const store = getStore("manual-attributions");
  await store.setJSON(record.id, record);

  return new Response(JSON.stringify({ ok: true, record }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

export const config: Config = {
  path: "/api/attributions/submit-admin",
};
