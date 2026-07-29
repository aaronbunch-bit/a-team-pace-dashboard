import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { getIdentityUser } from "./_shared/identity.mts";
import { requireAdmin } from "./_shared/access.mts";

// Full admins (Aaron OR anyone already on this list) can update the list.
// Aaron's email is never stored here — he's the permanent admin and
// isAdminEmail() / requireAdmin() always treat him as admin separately.

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
