import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { getIdentityUser } from "./_shared/identity.mts";
import { ADMIN_EMAIL } from "./_shared/access.mts";
import { resolveRepNameFromEmail } from "./_shared/roster.mts";
import { teamTodayYmd } from "./_shared/time.mts";

// Open to any signed-in user, not just Aaron/admins — deliberate design.
// Still requires real sign-in so `from` can be attributed truthfully instead
// of trusting whatever the client claims.
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
  const hidden = !!body?.hidden;
  if (!rep || !text) {
    return new Response(JSON.stringify({ error: "Pick a teammate and write a quick message first" }), { status: 400 });
  }

  // Server decides who "from" is — the client's body is never trusted for this.
  const email = String(user.email).toLowerCase();
  const resolvedName = await resolveRepNameFromEmail(email);
  const fromDisplayName =
    email === ADMIN_EMAIL ? "Aaron Bunch" : resolvedName || user.email;

  const now = new Date();
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const record = {
    id,
    rep,
    text,
    hidden,
    date: teamTodayYmd(now),
    createdAt: now.toISOString(),
    fromEmail: email,
    fromDisplayName,
  };
  const store = getStore("shoutouts");
  await store.setJSON(id, record);

  return new Response(
    JSON.stringify({
      ok: true,
      shoutout: { id, text, date: record.date, from: fromDisplayName, hidden },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
};

export const config: Config = {
  path: "/api/shoutouts/send",
};
