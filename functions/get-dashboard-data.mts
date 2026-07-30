import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { requireSignedIn } from "./_shared/identity.mts";

// Identity-gated (@varsitytutors.com). Roster / goals / actuals / access lists
// are team-internal — never serve them to anonymous callers with the URL.
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
// (Save Goals / Add Person / Update Actuals) — see fetchDashboardData().
export default async (req: Request, context: Context) => {
  const auth = await requireSignedIn(req, context);
  if (auth.response) return auth.response;

  const rosterStore = getStore("roster");
  const goalsStore = getStore("goals");
  const actualsStore = getStore("actuals");
  const prelimStore = getStore("prelim-snapshots");
  // Admin/Sales Coach access lists — unlike roster/goals/actuals above, these
  // have no baked-in front-end default worth protecting (an empty list IS the
  // correct starting point, since Aaron is always admin regardless of what's
  // in here), so they resolve to `[]` rather than `null` when nothing's been
  // saved yet.
  const adminListStore = getStore("admin-list");
  const coachListStore = getStore("coach-list");
  const sipExtraStore = getStore("sip-extra");

  const [roster, goals, actuals, prelim, admins, coaches, sipExtra] = await Promise.all([
    rosterStore.get("current", { type: "json" }),
    goalsStore.get("current", { type: "json" }),
    actualsStore.get("current", { type: "json" }),
    prelimStore.get("current", { type: "json" }),
    adminListStore.get("current", { type: "json" }),
    coachListStore.get("current", { type: "json" }),
    sipExtraStore.get("current", { type: "json" }),
  ]);

  return new Response(
    JSON.stringify({
      roster: roster || null,
      goals: goals || null,
      actuals: actuals || null,
      prelim: prelim || null,
      admins: admins || [],
      coaches: coaches || [],
      // Closed-out SIP months from the Historical Performance importer.
      // Empty array (not null) when nothing has been closed out yet.
      sipExtra: Array.isArray(sipExtra) ? sipExtra : [],
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    }
  );
};

export const config: Config = {
  path: "/api/dashboard/data",
};
