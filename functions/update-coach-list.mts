import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { getIdentityUser } from "./_shared/identity.mts";
import { requireAdmin } from "./_shared/access.mts";

// "Sales Coach" access list — lighter tier than admin-list. Full admins
// (Aaron or admin-list) can grant/revoke it. Coaches themselves get elevated
// READ access only (see canViewClientDetail/canViewTeamDetails).

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

  const coaches = body?.coaches;
  if (!Array.isArray(coaches) || !coaches.every((c) => typeof c === "string")) {
    return new Response(JSON.stringify({ error: "coaches must be an array of email strings" }), { status: 400 });
  }

  const store = getStore("coach-list");
  await store.setJSON("current", coaches);

  return new Response(JSON.stringify({ ok: true, coaches }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

export const config: Config = {
  path: "/api/coach-list/update",
};
