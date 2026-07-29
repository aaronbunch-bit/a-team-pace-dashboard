import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { getIdentityUser, requirePrimaryAdmin } from "./_shared/identity.mts";

const ADMIN_EMAIL = "aaron.bunch@varsitytutors.com";

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

  // Bulk save, same as the "Save goals" button always did client-side — the
  // whole { repDisplay: { sessions, members, tag, ote, capAt200, email } }
  // object gets replaced in one write rather than diffed field by field.
  const goals = body?.goals;
  if (!goals || typeof goals !== "object" || Array.isArray(goals)) {
    return new Response(JSON.stringify({ error: "goals must be an object" }), { status: 400 });
  }

  const store = getStore("goals");
  await store.setJSON("current", goals);

  return new Response(JSON.stringify({ ok: true, goals }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

export const config: Config = {
  path: "/api/goals/update",
};
