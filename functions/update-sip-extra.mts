import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { getIdentityUser } from "./_shared/identity.mts";
import { requireAdmin } from "./_shared/access.mts";

// Closed-out SIP months (from the Historical Performance CSV importer).
// Shared across every browser — must not live in localStorage.
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

  const sipExtra = body?.sipExtra;
  if (!Array.isArray(sipExtra)) {
    return new Response(JSON.stringify({ error: "sipExtra must be an array" }), { status: 400 });
  }

  const store = getStore("sip-extra");
  await store.setJSON("current", sipExtra);

  return new Response(JSON.stringify({ ok: true, sipExtra }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

export const config: Config = {
  path: "/api/sip-extra/update",
};
