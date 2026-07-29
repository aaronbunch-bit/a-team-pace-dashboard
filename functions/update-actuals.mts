import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { getIdentityUser, requirePrimaryAdmin } from "./_shared/identity.mts";

// Admin-only per Aaron's explicit instruction — updating actuals from a
// pasted ledger CSV changes what every rep sees as their live numbers, so
// it's locked down the same way badge/goal/roster writes are.
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

  const actualsStore = getStore("actuals");
  const prelimStore = getStore("prelim-snapshots");

  if (body?.action === "clearPrelim") {
    // Fired by Close Out Month once a month becomes official in Historical
    // Performance — drops its "Preliminary" snapshot so Client Detail defers
    // to History instead. Mirrors the old clearPrelimSnapshot()'s behavior.
    const month = String(body?.month || "");
    if (!month) return new Response(JSON.stringify({ error: "Missing month" }), { status: 400 });
    const all = (await prelimStore.get("current", { type: "json" })) || {};
    delete all[month];
    await prelimStore.setJSON("current", all);
    return new Response(JSON.stringify({ ok: true, prelim: all }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Default action: save a freshly-pasted CSV's computed actuals, optionally
  // freezing the outgoing month's numbers into the prelim-snapshot store
  // first (client detects the month rollover and includes prelimSnapshot
  // when it applies — see importActuals() in team-pace-dashboard.html,
  // mirroring the old updateActuals click handler's savePrelimSnapshot call).
  const actuals = body?.actuals;
  if (!actuals || typeof actuals !== "object") {
    return new Response(JSON.stringify({ error: "actuals must be an object" }), { status: 400 });
  }

  let prelim: any = null;
  if (body?.prelimSnapshot && body.prelimSnapshot.monthKey) {
    prelim = (await prelimStore.get("current", { type: "json" })) || {};
    prelim[body.prelimSnapshot.monthKey] = { ...body.prelimSnapshot.data, computedAt: new Date().toISOString() };
    await prelimStore.setJSON("current", prelim);
  }

  await actualsStore.setJSON("current", actuals);

  return new Response(JSON.stringify({ ok: true, actuals, prelim }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

export const config: Config = {
  path: "/api/actuals/update",
};
