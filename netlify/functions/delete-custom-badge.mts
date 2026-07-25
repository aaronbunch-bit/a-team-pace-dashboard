import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { getIdentityUser } from "./_shared/identity.mts";

const ADMIN_EMAIL = "aaron.bunch@varsitytutors.com";

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

  // Deletes only the badge TYPE. Same as the old localStorage behavior: any
  // existing assignments referencing this key are left alone and just quietly
  // stop rendering (see manualBadgesHTML's `if (!opt) return ''` on the front
  // end) rather than needing a cascading cleanup pass here.
  const store = getStore("custom-badges");
  await store.delete(key);

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

export const config: Config = {
  path: "/api/badges/custom/delete",
};
