import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { getIdentityUser } from "./_shared/identity.mts";

// Open to any signed-in user, not just Aaron/admins — matches the front end's
// existing "Send a Shoutout — open to anyone, no admin/coach gate" behavior.
// Still requires real sign-in (unlike the old localStorage version, which
// didn't check at all) so `from` can be attributed truthfully instead of
// trusting whatever the client claims — mirrors submit-attribution.mts's
// reasoning exactly.
const ADMIN_EMAIL = "aaron.bunch@varsitytutors.com";
// Same email -> display-name mapping submit-attribution.mts keeps for its own
// ROSTER_EMAILS — duplicated here rather than shared, since these are two
// separate Netlify Functions. Keep both in sync with the dashboard's ROSTER
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

  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid request body" }), { status: 400 });
  }

  const rep = String(body?.rep || "").trim();
  const text = String(body?.text || "").trim();
  if (!rep || !text) {
    return new Response(JSON.stringify({ error: "Pick a teammate and write a quick message first" }), { status: 400 });
  }

  // Server decides who "from" is — the client's body is never trusted for
  // this, so nobody can send a shoutout that appears to come from someone
  // else.
  const email = String(user.email).toLowerCase();
  const fromDisplayName = email === ADMIN_EMAIL ? "Aaron Bunch" : ROSTER_EMAILS[email] || user.email;

  const now = new Date();
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const record = {
    id,
    rep,
    text,
    date: now.toISOString().slice(0, 10),
    createdAt: now.toISOString(),
    fromEmail: email,
    fromDisplayName,
  };
  const store = getStore("shoutouts");
  await store.setJSON(id, record);

  return new Response(
    JSON.stringify({ ok: true, shoutout: { id, text, date: record.date, from: fromDisplayName } }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
};

export const config: Config = {
  path: "/api/shoutouts/send",
};
