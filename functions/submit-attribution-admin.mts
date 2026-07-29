import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { getIdentityUser, requirePrimaryAdmin } from "./_shared/identity.mts";

// Admin-only counterpart to submit-attribution.mts, for the "move a cancel
// into Manual Attribution" flow on the Team Details page. The regular
// submit-attribution.mts derives `repName` from the CALLER'S OWN identity
// (ROSTER_EMAILS[email]) specifically so nobody can submit a request claiming
// to be a different rep. This function is the one deliberate exception: an
// admin explicitly picking which rep a cancel belongs to and requesting it be
// reversed on that rep's behalf. Kept admin-only (not Sales-Coach-accessible)
// per Aaron's own call — same reasoning as every other write path in this
// app (update-roster.mts, update-goals.mts, delete-preset-badge.mts, etc.):
// Sales Coach identity isn't recognized server-side yet, so there's no way to
// verify a coach's identity here even if the front end wanted to allow it.
const ADMIN_EMAIL = "aaron.bunch@varsitytutors.com";

// Keep in sync with ROSTER_EMAILS' values in submit-attribution.mts and the
// dashboard's own ROSTER array — this is only used to reject an obvious typo
// in `repName`, not to resolve an email, so it's just the display-name list.
const VALID_REPS = new Set([
  "Becky Ruffer",
  "Brenda Wong",
  "Chris Jones",
  "David Valverde",
  "Del Ali",
  "Domenica Sorrentino",
  "Jenna Salupo",
  "Liz Weiss",
  "Tim Carr",
]);

export default async (req: Request, context: Context) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
  }

  const user = await getIdentityUser(req, context);
  const denied = requirePrimaryAdmin(user, ADMIN_EMAIL);
  if (denied) return denied;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid request body" }), { status: 400 });
  }

  const { repName, clientId, members, sessions, saleDate, reason, comments } = body || {};
  const membersNum = Number(members) || 0;
  const sessionsNum = Number(sessions) || 0;
  if (!repName || !VALID_REPS.has(String(repName))) {
    return new Response(JSON.stringify({ error: "repName must be a current rep on the roster" }), { status: 400 });
  }
  if (!clientId || (!membersNum && !sessionsNum) || !saleDate || !reason || !comments) {
    return new Response(
      JSON.stringify({ error: "Missing required fields (clientId, members or sessions, saleDate, reason, comments)" }),
      { status: 400 }
    );
  }

  const record = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    repEmail: null as string | null, // no rep email on file for an admin-initiated record — repName is authoritative here
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
    // Audit trail: who actually clicked submit and why this exists, since it
    // didn't come from the rep themselves like every other record in this store.
    submittedByAdmin: true,
    initiatedBy: String(user.email).toLowerCase(),
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
