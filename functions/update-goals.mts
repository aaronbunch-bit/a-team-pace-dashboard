import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { getIdentityUser } from "./_shared/identity.mts";
import { requireAdmin } from "./_shared/access.mts";
import {
  isMonthKey,
  liveMonthKey,
  loadGoalsByMonth,
  recordLiveMonthGoals,
  saveGoalsByMonth,
} from "./_shared/goals.mts";

const LEVEL_DEFAULT_OTE: Record<string, number> = {
  pt: 500,
  1: 1000,
  2: 1333,
  3: 1667,
};

function normalizeGoalRecord(raw: any) {
  const source = raw && typeof raw === "object" ? raw : {};
  const rawLevel = String(raw?.level || "").trim().toLowerCase();
  const parsedLevel = Number(rawLevel);
  const level = raw?.partTime === true || rawLevel === "pt" ? "pt" : parsedLevel === 2 || parsedLevel === 3 ? parsedLevel : 1;
  const savedOte = Number(raw?.ote);
  return {
    ...source,
    sessions: Math.max(0, Number(raw?.sessions) || 0),
    members: Math.max(0, Number(raw?.members) || 0),
    level,
    partTime: level === "pt",
    ote: Number.isFinite(savedOte) && savedOte >= 0 ? savedOte : LEVEL_DEFAULT_OTE[level],
    tag: String(raw?.tag || "").trim().slice(0, 120),
    email: String(raw?.email || "").trim().toLowerCase().slice(0, 160),
    capAt200: !!raw?.capAt200,
  };
}

export default async (req: Request, context: Context) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
  }

  const user = await getIdentityUser(req, context);
  const denied = await requireAdmin(user);
  if (denied) return denied;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid request body" }), { status: 400 });
  }

  // Bulk save, same as the "Save goals" button always did client-side. Normalize
  // compensation fields server-side so malformed levels cannot persist.
  const goals = body?.goals;
  if (!goals || typeof goals !== "object" || Array.isArray(goals)) {
    return new Response(JSON.stringify({ error: "goals must be an object" }), { status: 400 });
  }

  const normalizedGoals = Object.fromEntries(
    Object.entries(goals)
      .map(([name, goal]) => [String(name).trim(), normalizeGoalRecord(goal)])
      .filter(([name]) => !!name),
  );

  // Which month is being edited. Absent means the live month, which is how
  // every caller before the month toggle behaved.
  const requestedMonth = String(body?.month || "").trim();
  if (requestedMonth && !isMonthKey(requestedMonth)) {
    return new Response(JSON.stringify({ error: "month must be YYYY-MM" }), { status: 400 });
  }
  const live = liveMonthKey();
  const month = requestedMonth || live;

  // A closed month is edited in the archive only. The live `goals` document is
  // what every other view reads for *today*, so rewriting it to fix a past
  // month is exactly the bug this replaces.
  if (month !== live) {
    const byMonth = await loadGoalsByMonth();
    byMonth[month] = normalizedGoals;
    await saveGoalsByMonth(byMonth);
    return new Response(
      JSON.stringify({ ok: true, month, goals: normalizedGoals, goalsMonths: byMonth }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }

  const store = getStore("goals");
  const previous = (await store.get("current", { type: "json" })) as Record<string, any> | null;
  await store.setJSON("current", normalizedGoals);
  // Settle last month with the quotas that were in force for it before this
  // edit, so changing or clearing a quota now cannot rewrite its history.
  const goalsMonths = await recordLiveMonthGoals(normalizedGoals, previous, live);

  return new Response(
    JSON.stringify({ ok: true, month: live, goals: normalizedGoals, goalsMonths }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
};

export const config: Config = {
  path: "/api/goals/update",
};
