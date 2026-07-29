import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { getIdentityUser } from "./_shared/identity.mts";

// "Sales Coach" access list — a lighter tier than admin-list.mts. Same
// hardcoded-admin-only write gate as everywhere else: only Aaron can grant or
// revoke it, even though coaches themselves get elevated READ access once
// they're on this list (see canViewClientDetail/canViewTeamDetails on the
// front end).
const ADMIN_EMAIL = "aaron.bunch@varsitytutors.com";

export default async (req: Request, context: Context) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
  }

  const user = await getIdentityUser(req, context);
  if (!user || !user.email || String(user.email).toLowerCase() !== ADMIN_EMAIL) {
    return new Response(JSON.stringify({ error: "Only Aaron can manage Sales Coach access" }), { status: 403 });
  }

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
