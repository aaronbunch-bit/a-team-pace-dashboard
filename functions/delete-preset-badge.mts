import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { getIdentityUser } from "./_shared/identity.mts";

const ADMIN_EMAIL = "aaron.bunch@varsitytutors.com";

// Deletes one of the 8 BUILT-IN badge types (the 4 automatic ones in
// BADGE_TOGGLE_META — streak/personalBest/consistency/firstTo100 — or the 4
// built-in manual-assign presets in MANUAL_BADGE_OPTIONS — mvp/coachspick/
// risingstar/clutch) from the front end's "Badge Bank" list. Unlike custom
// badges (delete-custom-badge.mts), these keys are hardcoded in
// index.html, not stored records, so there's nothing to actually delete from
// a store — instead this keeps a permanent denylist of preset keys the admin
// has chosen to remove, and every reader (allBadgeOptions(), the Badge Bank
// render, the toggle list) filters against it. A key here also implicitly
// means "off" everywhere else on the dashboard, same as if it were toggled
// off, but it additionally disappears from the Badge Bank list entirely
// instead of just showing unchecked — reversible only by removing it from
// this list server-side (no "restore" UI on the front end for these, unlike
// custom badges which can just be recreated by name).
export default async (req: Request, context: Context) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
  }

  const user = await getIdentityUser(req, context);
  if (!user || !user.email || String(user.email).toLowerCase() !== ADMIN_EMAIL) {
    return new Response(JSON.stringify({ error: "Only Aaron can delete badges" }), { status: 403 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid request body" }), { status: 400 });
  }

  const key = String(body?.key || "");
  if (!key) {
    return new Response(JSON.stringify({ error: "Missing key" }), { status: 400 });
  }

  const store = getStore("badge-deleted-presets");
  const current: string[] = (await store.get("current", { type: "json" })) || [];
  const deletedPresets = current.includes(key) ? current : current.concat([key]);
  await store.setJSON("current", deletedPresets);

  return new Response(JSON.stringify({ ok: true, deletedPresets }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

export const config: Config = {
  path: "/api/badges/preset/delete",
};
