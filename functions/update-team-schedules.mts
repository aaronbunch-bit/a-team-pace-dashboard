import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { getIdentityUser } from "./_shared/identity.mts";
import { resolveAccess } from "./_shared/access.mts";
import { loadValidRepDisplays } from "./_shared/roster.mts";

const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

function cleanShift(value: unknown): string {
  return String(value ?? "").trim().slice(0, 40);
}

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
  if (!access || !(access.isFullAdmin || access.isCoach)) {
    return new Response(JSON.stringify({ error: "Coach or admin access required" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid request body" }), { status: 400 });
  }

  const validReps = await loadValidRepDisplays();
  const incoming = body?.reps && typeof body.reps === "object" ? body.reps : {};
  const reps: Record<string, Record<string, string>> = {};

  for (const [rep, days] of Object.entries(incoming)) {
    if (!validReps.has(rep)) continue;
    const row: Record<string, string> = {};
    for (const key of DAY_KEYS) {
      row[key] = cleanShift((days as any)?.[key]);
    }
    reps[rep] = row;
  }

  // Ensure every active roster name has a row (blank = unset).
  for (const rep of validReps) {
    if (!reps[rep]) {
      reps[rep] = Object.fromEntries(DAY_KEYS.map((k) => [k, ""]));
    }
  }

  const dailyGoals: Record<string, number> = {};
  const rawGoals = body?.dailyGoals && typeof body.dailyGoals === "object" ? body.dailyGoals : {};
  for (const key of DAY_KEYS) {
    const n = Number((rawGoals as any)[key]);
    dailyGoals[key] = Number.isFinite(n) && n >= 0 ? n : 0;
  }

  const payload = {
    reps,
    dailyGoals,
    updatedAt: new Date().toISOString(),
    updatedBy: access.email,
  };

  const store = getStore("team-schedules");
  await store.setJSON("current", payload);

  return new Response(JSON.stringify({ ok: true, ...payload }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

export const config: Config = {
  path: "/api/team-schedules/update",
};
