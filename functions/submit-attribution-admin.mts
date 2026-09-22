import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { getIdentityUser } from "./_shared/identity.mts";
import { resolveAccess } from "./_shared/access.mts";
import { loadValidRepDisplays, resolveEmailFromRepDisplay } from "./_shared/roster.mts";
import { teamTodayYmd } from "./_shared/time.mts";
import {
  findAttrDuplicates,
  membersValidationError,
  normalizeAttrMembers,
} from "./_shared/attribution.mts";

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
  const validReps = await loadValidRepDisplays();
  if (!repName || !validReps.has(String(repName))) {
    return new Response(JSON.stringify({ error: "repName must be a current rep on the roster" }), {
      status: 400,
    });
  }

  const initiatedBy = String(user.email).toLowerCase();
  const repEmail = await resolveEmailFromRepDisplay(String(repName));

  if (isOnBehalf) {
    const membersErr = membersValidationError(members);
    if (membersErr) {
      return new Response(JSON.stringify({ error: membersErr }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    const { clientLink, contact, adjustmentReason, comments } = body || {};
    const contactStr = contact != null ? String(contact).trim() : "";
    if (!clientLink || !contactStr || !membersNum || !adjustmentReason || !comments) {
      return new Response(
        JSON.stringify({
          error: "Missing required fields (clientLink, contact, members, adjustmentReason, comments)",
        }),
        { status: 400 }
      );
    }
    const store = getStore("manual-attributions");
    const forceDuplicate = !!(body?.forceDuplicate || body?.confirmDuplicate);
    if (!forceDuplicate) {
      const { blobs } = await store.list();
      const existing = (
        await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" })))
      ).filter(Boolean);
      const matches = findAttrDuplicates(existing as any[], {
        clientLink,
        contact: contactStr,
      });
      if (matches.length) {
        return new Response(
          JSON.stringify({
            error: "A request for this client has already been submitted",
            duplicate: true,
            matches: matches.slice(0, 5),
          }),
          { status: 409, headers: { "Content-Type": "application/json" } }
        );
      }
    }
    const record = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      repEmail,
      repName: String(repName),
      clientLink: String(clientLink).trim(),
      contact: contactStr,
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
    await store.setJSON(record.id, record);
    return new Response(JSON.stringify({ ok: true, record }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Cancel → Manual Attribution conversion (legacy field names).
  // Sessions-only cancels may still request members = 0.
  // Only full admins can convert cancels; land approved so they don't re-approve.
  const membersErr = membersValidationError(members, { allowZero: true });
  if (membersErr) {
    return new Response(JSON.stringify({ error: membersErr }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (!membersNum && !sessionsNum) {
    return new Response(
      JSON.stringify({ error: "Missing required fields (members or sessions)" }),
      { status: 400 }
    );
  }
  const { clientId, saleDate, reason, comments, clientLink: bodyClientLink } = body || {};
  if (!clientId || !saleDate || !reason || !comments) {
    return new Response(
      JSON.stringify({
        error: "Missing required fields (clientId, members or sessions, saleDate, reason, comments)",
      }),
      { status: 400 }
    );
  }

  const clientIdStr = String(clientId).trim();
  const note = String(comments).trim();
  const reasonStr = String(reason).trim();
  const now = new Date().toISOString();
  // Prefer an explicit link from the client; otherwise build the standard
  // Varsity Tutors client page so CSV export / UI never get a bare id.
  const clientLink = String(bodyClientLink || "").trim()
    || (clientIdStr ? `https://www.varsitytutors.com/clients/${encodeURIComponent(clientIdStr)}` : "");

  const record = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    repEmail,
    repName: String(repName),
    clientId: clientIdStr,
    clientLink,
    members: membersNum,
    sessions: sessionsNum,
    saleDate: String(saleDate).slice(0, 10),
    reason: reasonStr,
    adjustmentReason: reasonStr,
    // Admin convert comments are the approval note — no second review step.
    comments: note,
    reviewComment: note,
    status: "approved",
    submittedAt: now,
    reviewedAt: now,
    reviewedBy: initiatedBy,
    submittedByAdmin: true,
    initiatedBy,
    source: "cancel-conversion",
    decisionHistory: [
      {
        from: "pending",
        to: "approved",
        action: "approve",
        by: initiatedBy,
        at: now,
        note,
      },
    ],
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
