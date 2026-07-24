import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { getIdentityUser } from "./_shared/identity.mts";

// Company email (lowercase) -> the exact rep display name used in the dashboard's
// ROSTER / DEFAULT_GOALS. Keep this in sync with team-pace-dashboard.html's ROSTER
// whenever the team roster changes.
const ROSTER_EMAILS: Record<string, string> = {
  "becky.ruffer@varsitytutors.com": "Becky Ruffer",
  "brenda.wong@varsitytutors.com": "Brenda Wong",
  "christopher.jones@varsitytutors.com": "Chris Jones",
  "david.valverde@varsitytutors.com": "David Valverde",
  "del.ali@varsitytutors.com": "Del Ali",
  "domenica.sorrentino@varsitytutors.com": "Domenica Sorrentino",
  "jenna.salupo@varsitytutors.com": "Jenna Salupo",
  "liz.weiss@varsitytutors.com": "Liz Weiss",
  "timothy.carr@varsitytutors.com": "Tim Carr",
};

export default async (req: Request, context: Context) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
  }

  const user = await getIdentityUser(req, context);
  if (!user || !user.email) {
    return new Response(JSON.stringify({ error: "Not signed in" }), { status: 401 });
  }

  const email = String(user.email).toLowerCase();
  const repName = ROSTER_EMAILS[email];
  if (!repName) {
    return new Response(
      JSON.stringify({ error: "Your account isn't mapped to a rep on this dashboard yet — ask Aaron to add you." }),
      { status: 403 }
    );
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid request body" }), { status: 400 });
  }

  const { clientId, members, sessions, saleDate, reason } = body || {};
  const membersNum = Number(members) || 0;
  const sessionsNum = Number(sessions) || 0;
  if (!clientId || (!membersNum && !sessionsNum) || !saleDate || !reason) {
    return new Response(
      JSON.stringify({ error: "Missing required fields (clientId, members or sessions, saleDate, reason)" }),
      { status: 400 }
    );
  }

  const record = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    repEmail: email,
    repName,
    clientId: String(clientId).trim(),
    members: membersNum,
    sessions: sessionsNum,
    saleDate: String(saleDate).slice(0, 10),
    reason: String(reason).trim(),
    status: "pending",
    submittedAt: new Date().toISOString(),
    reviewedAt: null as string | null,
    reviewedBy: null as string | null,
  };

  const store = getStore("manual-attributions");
  await store.setJSON(record.id, record);

  return new Response(JSON.stringify({ ok: true, record }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

export const config: Config = {
  path: "/api/attributions/submit",
};
