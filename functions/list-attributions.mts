import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { getIdentityUser } from "./_shared/identity.mts";

// The sole approver — matches Aaron's request that only he can approve/reject.
// No Netlify Identity "roles" setup needed; this is just a hardcoded check.
const ADMIN_EMAIL = "aaron.bunch@varsitytutors.com";

export default async (req: Request, context: Context) => {
  const user = await getIdentityUser(req, context);
  if (!user || !user.email) {
    return new Response(JSON.stringify({ error: "Not signed in" }), { status: 401 });
  }
  const email = String(user.email).toLowerCase();
  const isAdmin = email === ADMIN_EMAIL;

  const store = getStore("manual-attributions");
  const { blobs } = await store.list();
  const records = (await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" })))).filter(Boolean);

  const visible = isAdmin ? records : records.filter((r: any) => r.repEmail === email);
  visible.sort((a: any, b: any) => (b.submittedAt || "").localeCompare(a.submittedAt || ""));

  return new Response(JSON.stringify({ isAdmin, records: visible }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

export const config: Config = {
  path: "/api/attributions/list",
};
