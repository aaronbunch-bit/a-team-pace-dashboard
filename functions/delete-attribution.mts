import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { getIdentityUser } from "./_shared/identity.mts";
import { resolveAccess } from "./_shared/access.mts";
import { resolveRepNameFromEmail } from "./_shared/roster.mts";

/**
 * Delete a Manual Attribution request.
 *  - Reps: their own submissions, or anything credited to their roster name
 *    (including coach/admin on-behalf submits).
 *  - Full admins + Sales Coaches: any request.
 */
export default async (req: Request, context: Context) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
  }

  const user = await getIdentityUser(req, context);
  if (!user?.email) {
    return new Response(JSON.stringify({ error: "Not signed in" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const access = await resolveAccess(user.email);
  if (!access) {
    return new Response(JSON.stringify({ error: "Not signed in" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid request body" }), { status: 400 });
  }

  const id = String(body?.id || "").trim();
  if (!id) {
    return new Response(JSON.stringify({ error: "Missing id" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const store = getStore("manual-attributions");
  const record: any = await store.get(id, { type: "json" });
  if (!record) {
    return new Response(JSON.stringify({ error: "Request not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  const email = access.email;
  const ownName = await resolveRepNameFromEmail(email);
  const isOwner =
    String(record.repEmail || "").toLowerCase() === email ||
    (!!ownName && String(record.repName || "") === ownName);

  // canViewTeam = full admin OR Sales Coach
  if (!access.canViewTeam && !isOwner) {
    return new Response(
      JSON.stringify({ error: "You can only delete your own Manual Attribution requests" }),
      { status: 403, headers: { "Content-Type": "application/json" } }
    );
  }

  await store.delete(id);

  return new Response(
    JSON.stringify({
      ok: true,
      deletedId: id,
      wasApproved: record.status === "approved",
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }
  );
};

export const config: Config = {
  path: "/api/attributions/delete",
};
