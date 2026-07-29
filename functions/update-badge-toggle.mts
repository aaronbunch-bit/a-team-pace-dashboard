import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { getIdentityUser, requirePrimaryAdmin } from "./_shared/identity.mts";

// Same hardcoded-admin pattern as list-attributions.mts/review-attribution.mts —
// no Netlify Identity "roles" setup, just a plain email check. Sales Coaches
// (the front end's isLimitedAdminEmail()) are NOT granted write access here on
// purpose: that list lives in the dashboard's own localStorage today (not yet
// synced to any backend), so there's no server-side source of truth for who's
// a coach yet. If that changes, this is the one line to update.
const ADMIN_EMAIL = "aaron.bunch@varsitytutors.com";
const TOGGLE_KEYS = ["streak", "personalBest", "consistency", "firstTo100"];

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

  const { key, enabled } = body || {};
  if (!TOGGLE_KEYS.includes(key)) {
    return new Response(JSON.stringify({ error: "Unknown badge key" }), { status: 400 });
  }

  const store = getStore("badge-toggles");
  const current = (await store.get("settings", { type: "json" })) || {};
  current[key] = !!enabled;
  await store.setJSON("settings", current);

  return new Response(JSON.stringify({ ok: true, toggles: current }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

export const config: Config = {
  path: "/api/badges/toggle",
};
