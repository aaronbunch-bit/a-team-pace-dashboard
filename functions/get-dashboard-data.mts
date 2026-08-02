import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { requireSignedIn } from "./_shared/identity.mts";
import { resolveAccess } from "./_shared/access.mts";
import { GOALS_MONTHS_KEY, GOALS_MONTHS_STORE, isMonthKey } from "./_shared/goals.mts";
import { ROSTER_MONTHS_KEY, ROSTER_MONTHS_STORE, normalizeRosterEntries } from "./_shared/roster-months.mts";
import {
  TEAM_MONTH_SETTINGS_KEY,
  TEAM_MONTH_SETTINGS_STORE,
  normalizeTeamMonthSettingsDoc,
} from "./_shared/team-month-settings.mts";

function redactCompensation(goals: any, viewerEmail: string, fullAccess: boolean) {
  if (!goals || typeof goals !== "object" || fullAccess) return goals || null;
  const email = String(viewerEmail || "").trim().toLowerCase();
  return Object.fromEntries(Object.entries(goals).map(([name, raw]) => {
    const goal = raw && typeof raw === "object" ? { ...(raw as Record<string, any>) } : {};
    const isOwn = String(goal.email || "").trim().toLowerCase() === email;
    if (!isOwn) {
      goal.partTime = String(goal.level || "").trim().toLowerCase() === "pt" || goal.partTime === true;
      delete goal.ote;
      delete goal.level;
      goal.compensationRestricted = true;
    }
    return [name, goal];
  }));
}

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
  const viewerEmail = String(auth.user?.email || "").trim().toLowerCase();
  const access = await resolveAccess(viewerEmail);

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
  // Quotas as they stood in each closed month, so a last-month view reads that
  // month's numbers instead of whatever is set today.
  const goalsMonthsStore = getStore(GOALS_MONTHS_STORE);
  // Who was on the team in each closed month — same idea for roster removals.
  const rosterMonthsStore = getStore(ROSTER_MONTHS_STORE);
  const teamMonthSettingsStore = getStore(TEAM_MONTH_SETTINGS_STORE);

  const [roster, goals, actuals, prelim, admins, coaches, sipExtra, goalsMonths, rosterMonths, teamMonthSettings] = await Promise.all([
    rosterStore.get("current", { type: "json" }),
    goalsStore.get("current", { type: "json" }),
    actualsStore.get("current", { type: "json" }),
    prelimStore.get("current", { type: "json" }),
    adminListStore.get("current", { type: "json" }),
    coachListStore.get("current", { type: "json" }),
    sipExtraStore.get("current", { type: "json" }),
    goalsMonthsStore.get(GOALS_MONTHS_KEY, { type: "json" }),
    rosterMonthsStore.get(ROSTER_MONTHS_KEY, { type: "json" }),
    teamMonthSettingsStore.get(TEAM_MONTH_SETTINGS_KEY, { type: "json" }),
  ]);
  const safeGoals = redactCompensation(goals, viewerEmail, !!access?.isFullAdmin);
  const safeGoalsMonths = goalsMonths && typeof goalsMonths === "object" && !Array.isArray(goalsMonths)
    ? Object.fromEntries(
        Object.entries(goalsMonths as Record<string, any>)
          .filter(([month, doc]) => isMonthKey(month) && !!doc && typeof doc === "object")
          .map(([month, doc]) => [
            month,
            redactCompensation(doc, viewerEmail, !!access?.isFullAdmin),
          ])
      )
    : {};
  const safeRosterMonths = rosterMonths && typeof rosterMonths === "object" && !Array.isArray(rosterMonths)
    ? Object.fromEntries(
        Object.entries(rosterMonths as Record<string, any>)
          .filter(([month, list]) => isMonthKey(month) && Array.isArray(list))
          .map(([month, list]) => [month, normalizeRosterEntries(list)])
      )
    : {};
  const safePrelim = prelim && typeof prelim === "object"
    ? Object.fromEntries(Object.entries(prelim as Record<string, any>).map(([month, snapshot]) => [
        month,
        snapshot && typeof snapshot === "object"
          ? {
              ...snapshot,
              goals: redactCompensation(snapshot.goals, viewerEmail, !!access?.isFullAdmin),
            }
          : snapshot,
      ]))
    : prelim;

  return new Response(
    JSON.stringify({
      roster: roster || null,
      rosterMonths: safeRosterMonths,
      goals: safeGoals,
      goalsMonths: safeGoalsMonths,
      teamMonthSettings: normalizeTeamMonthSettingsDoc(teamMonthSettings),
      actuals: actuals || null,
      prelim: safePrelim || null,
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
