import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

// Deliberately PUBLIC / no auth check — every viewer of the dashboard needs to
// see everyone's badges (toggle state + who's wearing what), same reasoning as
// approved-totals.mts. Nothing sensitive lives here (badge names/descriptions,
// who's assigned what) — the confidential payout numbers stay behind the
// Identity-gated attribution endpoints, untouched by this file.
//
// One combined endpoint (toggles + custom badge types + assignments) instead
// of three separate calls, since the dashboard always needs all three together
// on page load — mirrors the "one call on page load" shape get-dashboard-data
// was scoped to in the original migration plan, just limited to badges here.
const DEFAULT_TOGGLES = { streak: true, personalBest: true, consistency: true, firstTo100: true };

export default async (req: Request, context: Context) => {
  const togglesStore = getStore("badge-toggles");
  const customStore = getStore("custom-badges");
  const assignStore = getStore("badge-assignments");

  const [togglesRaw, customList, assignList] = await Promise.all([
    togglesStore.get("settings", { type: "json" }),
    customStore.list().then(({ blobs }) => Promise.all(blobs.map((b) => customStore.get(b.key, { type: "json" })))),
    assignStore.list().then(({ blobs }) => Promise.all(blobs.map((b) => assignStore.get(b.key, { type: "json" })))),
  ]);

  const toggles = Object.assign({}, DEFAULT_TOGGLES, togglesRaw || {});
  const custom = (customList || []).filter(Boolean);

  // Assignments come back as flat records ({id, rep, badgeKey, ...}); the
  // dashboard wants them grouped by rep display name (same shape the old
  // MANUAL_BADGES_KEY localStorage object used), so group them here rather
  // than making the front end do it.
  const assignments: Record<string, { id: string; key: string }[]> = {};
  for (const a of (assignList || []).filter(Boolean) as any[]) {
    if (!assignments[a.rep]) assignments[a.rep] = [];
    assignments[a.rep].push({ id: a.id, key: a.badgeKey });
  }

  return new Response(JSON.stringify({ toggles, custom, assignments }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

export const config: Config = {
  path: "/api/badges/data",
};
