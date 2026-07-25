import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

// Deliberately PUBLIC / no auth check, same reasoning as approved-totals.mts
// and get-badges-data.mts — every viewer needs the roster/goals/actuals to
// render the dashboard at all, not just whoever's signed in.
//
// Each of these stores holds ONE blob under the key "current" — roster,
// goals, and actuals (and the derived prelim-snapshot record) are each a
// single evolving document, not a list of independent submitted records the
// way attributions/shoutouts/badge-assignments are, so there's nothing to
// list() here.
//
// IMPORTANT: this deliberately does NOT seed these stores with the
// dashboard's baked-in defaults (the 9-person ROSTER, DEFAULT_GOALS, or the
// large DEFAULT_ACTUALS ledger snapshot) if they're empty. Duplicating that
// data here (especially DEFAULT_ACTUALS, a real ledger export) would mean
// keeping two copies in sync across two files/languages. Instead, a `null`
// field here means "nothing saved yet" and the front end's own cache just
// keeps showing its baked-in default until the first real write happens
// (Save Goals / Add Person / Update Actuals) — see fetchDashboardData() in
// team-pace-dashboard.html. From that point on every browser reads the real
// shared value instead of its own local default.
export default async (req: Request, context: Context) => {
  const rosterStore = getStore("roster");
  const goalsStore = getStore("goals");
  const actualsStore = getStore("actuals");
  const prelimStore = getStore("prelim-snapshots");

  const [roster, goals, actuals, prelim] = await Promise.all([
    rosterStore.get("current", { type: "json" }),
    goalsStore.get("current", { type: "json" }),
    actualsStore.get("current", { type: "json" }),
    prelimStore.get("current", { type: "json" }),
  ]);

  return new Response(
    JSON.stringify({ roster: roster || null, goals: goals || null, actuals: actuals || null, prelim: prelim || null }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
};

export const config: Config = {
  path: "/api/dashboard/data",
};
