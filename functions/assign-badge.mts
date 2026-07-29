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

  const rep = String(body?.rep || "").trim();
  const badgeKey = String(body?.key || "").trim();
  if (!rep || !badgeKey) {
    return new Response(JSON.stringify({ error: "Missing rep or badge key" }), { status: 400 });
  }

  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const record = { id, rep, badgeKey, assignedBy: user.email, assignedAt: new Date().toISOString() };
  const store = getStore("badge-assignments");
  await store.setJSON(id, record);

  return new Response(JSON.stringify({ ok: true, assignment: { id, key: badgeKey } }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

export const config: Config = {
  path: "/api/badges/assign",
};
