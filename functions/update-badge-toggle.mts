import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { getIdentityUser } from "./_shared/identity.mts";
import { requireAdmin } from "./_shared/access.mts";

// Full admins only (Aaron or admin-list). Sales Coaches stay read-only.
const TOGGLE_KEYS = ["streak", "personalBest", "consistency", "firstTo100", "earlyBird"];

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
