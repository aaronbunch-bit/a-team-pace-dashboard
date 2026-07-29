import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { getIdentityUser } from "./_shared/identity.mts";
import { resolveAccess } from "./_shared/access.mts";

// Visibility:
//   - Primary admin (Aaron), listed admins, and Sales Coaches see every rep's
//     requests (Team Details + Manual Attribution team view).
//   - Everyone else only sees their own.
// Approve/reject stays Aaron-only (`isAdmin` / review-attribution.mts) — coaches
// and listed admins get read access here, not write/approve authority.
export default async (req: Request, context: Context) => {
  const user = await getIdentityUser(req, context);
  if (!user || !user.email) {
    return new Response(JSON.stringify({ error: "Not signed in" }), { status: 401 });
  }

  const access = await resolveAccess(user.email);
  if (!access) {
    return new Response(JSON.stringify({ error: "Not signed in" }), { status: 401 });
  }

  const store = getStore("manual-attributions");
  const { blobs } = await store.list();
  const records = (await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" })))).filter(Boolean);

  const visible = access.canViewTeam
    ? records
    : records.filter((r: any) => r.repEmail === access.email);
  visible.sort((a: any, b: any) => (b.submittedAt || "").localeCompare(a.submittedAt || ""));

  return new Response(
    JSON.stringify({
      isAdmin: access.isPrimaryAdmin,
      canViewTeam: access.canViewTeam,
      records: visible,
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }
  );
};

export const config: Config = {
  path: "/api/attributions/list",
};
