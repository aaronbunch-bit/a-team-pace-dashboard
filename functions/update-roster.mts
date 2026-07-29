import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { getIdentityUser, requirePrimaryAdmin } from "./_shared/identity.mts";

// Same hardcoded-admin pattern as the badge-management functions — no
// Netlify Identity "roles" setup, just a plain email check. Sales Coaches
// (isLimitedAdminEmail() on the front end) are NOT granted write access here,
// same reasoning as update-badge-toggle.mts.
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

  // The client sends the FULL resolved roster array (it already has to
  // compute this locally today — base roster + added people, minus removed
  // people via an `active` flag — see ROSTER_CACHE in team-pace-dashboard.html),
  // this function just persists whatever it's given rather than trying to
  // apply a diff against a store that may not have been written to yet.
  const roster = body?.roster;
  if (!Array.isArray(roster)) {
    return new Response(JSON.stringify({ error: "roster must be an array" }), { status: 400 });
  }
  for (const r of roster) {
    if (!r || typeof r.display !== "string" || !r.display.trim()) {
      return new Response(JSON.stringify({ error: "Every roster entry needs a display name" }), { status: 400 });
    }
  }

  const store = getStore("roster");
  await store.setJSON("current", roster);

  return new Response(JSON.stringify({ ok: true, roster }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

export const config: Config = {
  path: "/api/roster/update",
};
