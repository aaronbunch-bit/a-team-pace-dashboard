import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { requireSignedIn } from "./_shared/identity.mts";
import { withApiErrors } from "./_shared/api-errors.mts";

// Identity-gated (@varsitytutors.com). Badge toggles / assignments are
// team-internal UI state — not for anonymous URL scrapers.
//
// One combined endpoint (toggles + custom badge types + assignments) instead
// of three separate calls, since the dashboard always needs all three together
// on page load.
const DEFAULT_TOGGLES = {
  streak: true,
  personalBest: true,
  consistency: true,
  firstTo100: true,
  earlyBird: true,
  hatTrick: true,
  rebound: true,
  nightOwl: true,
  bestPaceDay: true,
};

export default withApiErrors("get-badges-data", async (req: Request, context: Context) => {
  const auth = await requireSignedIn(req, context);
  if (auth.response) return auth.response;

  const togglesStore = getStore("badge-toggles");
  const customStore = getStore("custom-badges");
  const assignStore = getStore("badge-assignments");
  const deletedPresetsStore = getStore("badge-deleted-presets");
  const tipOverridesStore = getStore("badge-tip-overrides");

  const [togglesRaw, customList, assignList, deletedPresets, tipOverrides] = await Promise.all([
    togglesStore.get("settings", { type: "json" }),
    customStore.list().then(({ blobs }) => Promise.all(blobs.map((b) => customStore.get(b.key, { type: "json" })))),
    assignStore.list().then(({ blobs }) => Promise.all(blobs.map((b) => assignStore.get(b.key, { type: "json" })))),
    deletedPresetsStore.get("current", { type: "json" }),
    tipOverridesStore.get("current", { type: "json" }),
  ]);

  const toggles = Object.assign({}, DEFAULT_TOGGLES, togglesRaw || {});
  const custom = (customList || []).filter(Boolean);

  // Assignments come back as flat records ({id, rep, badgeKey, assignedAt, ...});
  // the dashboard wants them grouped by rep display name (same shape the old
  // MANUAL_BADGES_KEY localStorage object used), so group them here rather
  // than making the front end do it. Keep assignedAt/assignedBy so the
  // Recognition Wall can sort badge awards into the mixed feed.
  const assignments: Record<string, { id: string; key: string; assignedAt?: string; assignedBy?: string }[]> = {};
  for (const a of (assignList || []).filter(Boolean) as any[]) {
    if (!assignments[a.rep]) assignments[a.rep] = [];
    assignments[a.rep].push({
      id: a.id,
      key: a.badgeKey,
      assignedAt: a.assignedAt || undefined,
      assignedBy: a.assignedBy || undefined,
    });
  }

  return new Response(JSON.stringify({
    toggles,
    custom,
    assignments,
    deletedPresets: deletedPresets || [],
    tipOverrides: tipOverrides || {},
  }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
});

export const config: Config = {
  path: "/api/badges/data",
};
