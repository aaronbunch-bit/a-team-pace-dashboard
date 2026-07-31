import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { getIdentityUser } from "./_shared/identity.mts";
import { requireAdmin } from "./_shared/access.mts";

const LEVEL_DEFAULT_OTE: Record<number, number> = {
  1: 1000,
  2: 1333,
  3: 1667,
};

function normalizeGoalRecord(raw: any) {
  const parsedLevel = Number(raw?.level);
  const level = parsedLevel === 2 || parsedLevel === 3 ? parsedLevel : 1;
  const savedOte = Number(raw?.ote);
  return {
    sessions: Math.max(0, Number(raw?.sessions) || 0),
    members: Math.max(0, Number(raw?.members) || 0),
    level,
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
      .map(([name, goal]) => [String(name).trim().slice(0, 100), normalizeGoalRecord(goal)])
      .filter(([name]) => !!name),
  );

  const store = getStore("goals");
  await store.setJSON("current", normalizedGoals);

  return new Response(JSON.stringify({ ok: true, goals: normalizedGoals }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

export const config: Config = {
  path: "/api/goals/update",
};
