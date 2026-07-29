import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { getIdentityUser } from "./_shared/identity.mts";

// Same hardcoded-admin pattern as every other write path in this app. Aaron's
// own email is never stored in this list — he's the one permanent admin and
// isAdminEmail() on the front end always checks his email first, separately
// from whatever's in this store.
const ADMIN_EMAIL = "aaron.bunch@varsitytutors.com";

export default async (req: Request, context: Context) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
  }

  const user = await getIdentityUser(req, context);
  if (!user || !user.email || String(user.email).toLowerCase() !== ADMIN_EMAIL) {
    return new Response(JSON.stringify({ error: "Only Aaron can manage admin access" }), { status: 403 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid request body" }), { status: 400 });
  }

  // Client sends the full resolved list every time (add/remove already
  // computed locally) — same "just persist what you're given" contract as
  // update-roster.mts, no server-side diffing needed.
  const admins = body?.admins;
  if (!Array.isArray(admins) || !admins.every((a) => typeof a === "string")) {
    return new Response(JSON.stringify({ error: "admins must be an array of email strings" }), { status: 400 });
  }

  const store = getStore("admin-list");
  await store.setJSON("current", admins);

  return new Response(JSON.stringify({ ok: true, admins }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

export const config: Config = {
  path: "/api/admin-list/update",
};
