import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { getIdentityUser } from "./_shared/identity.mts";

// Admin-only, same reasoning as update-badge-toggle.mts.
const ADMIN_EMAIL = "aaron.bunch@varsitytutors.com";
// Same fixed rotation the front end used when this lived in localStorage
// (CUSTOM_BADGE_COLORS) — kept here since color assignment now happens
// server-side (based on how many custom badges already exist).
const CUSTOM_BADGE_COLORS = ["#7c3aed", "#0891b2", "#db2777", "#65a30d", "#ea580c", "#4338ca"];

export default async (req: Request, context: Context) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
  }

  const user = await getIdentityUser(req, context);
  if (!user || !user.email || String(user.email).toLowerCase() !== ADMIN_EMAIL) {
    return new Response(JSON.stringify({ error: "Only Aaron can create badges" }), { status: 403 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid request body" }), { status: 400 });
  }

  const label = String(body?.label || "").trim();
  if (!label) {
    return new Response(JSON.stringify({ error: "Give the badge a name first" }), { status: 400 });
  }
  const emoji = String(body?.emoji || "").trim() || "🏅";
  const description = String(body?.description || "").trim();

  const store = getStore("custom-badges");
  const { blobs } = await store.list();
  const color = CUSTOM_BADGE_COLORS[blobs.length % CUSTOM_BADGE_COLORS.length];
  const key = "custom_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const record = { key, emoji, label, description, color, custom: true };
  await store.setJSON(key, record);

  return new Response(JSON.stringify({ ok: true, badge: record }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

export const config: Config = {
  path: "/api/badges/custom/create",
};
