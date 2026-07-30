import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { getIdentityUser } from "./_shared/identity.mts";
import { resolveAccess } from "./_shared/access.mts";
import { resolveRepNameFromEmail } from "./_shared/roster.mts";

// Visibility:
//   - Full admins (Aaron + admin-list) and Sales Coaches see every rep's
//     requests (Team Details + Manual Attribution team view).
//   - Everyone else only sees requests credited to them — by repEmail OR
//     roster display name (so admin/coach on-behalf submits still land in
//     that rep's Pending / Actioned queues).
// Approve/reject UI (`isAdmin`) is full admins only — coaches stay read-only.
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

  let visible = records as any[];
  if (!access.canViewTeam) {
    const ownName = await resolveRepNameFromEmail(access.email);
    visible = records.filter((r: any) => {
      const byEmail = String(r.repEmail || "").toLowerCase() === access.email;
      const byName = !!ownName && String(r.repName || "") === ownName;
      return byEmail || byName;
    });
  }
  visible.sort((a: any, b: any) => (b.submittedAt || "").localeCompare(a.submittedAt || ""));

  return new Response(
    JSON.stringify({
      isAdmin: access.isFullAdmin,
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
