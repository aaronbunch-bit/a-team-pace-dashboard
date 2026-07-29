import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { getIdentityUser } from "./_shared/identity.mts";
import { resolveAccess } from "./_shared/access.mts";
import { loadValidRepDisplays, resolveRepNameFromEmail } from "./_shared/roster.mts";

const KINDS = new Set(["compositePct", "members", "sessions"]);

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

  const rep = String(body?.rep || "").trim();
  const kind = String(body?.kind || "").trim();
  const target = Number(body?.target);
  const month = String(body?.month || new Date().toISOString().slice(0, 7)).slice(0, 7);

  const validReps = await loadValidRepDisplays();
  if (!rep || !validReps.has(rep)) {
    return new Response(JSON.stringify({ error: "rep must be a current roster display name" }), {
      status: 400,
    });
  }
  if (!KINDS.has(kind)) {
    return new Response(
      JSON.stringify({ error: "kind must be compositePct, members, or sessions" }),
      { status: 400 }
    );
  }
  if (!Number.isFinite(target) || target <= 0) {
    return new Response(JSON.stringify({ error: "target must be a positive number" }), {
      status: 400,
    });
  }
  if (kind === "compositePct" && (target < 50 || target > 250)) {
    return new Response(JSON.stringify({ error: "Attainment target should be between 50 and 250" }), {
      status: 400,
    });
  }
  if (!/^\d{4}-\d{2}$/.test(month)) {
    return new Response(JSON.stringify({ error: "month must be YYYY-MM" }), { status: 400 });
  }

  const ownRep = await resolveRepNameFromEmail(access.email);
  const canSetForOthers = access.isFullAdmin || access.isCoach;
  if (ownRep !== rep && !canSetForOthers) {
    return new Response(
      JSON.stringify({ error: "You can only set a personal goal for yourself." }),
      { status: 403, headers: { "Content-Type": "application/json" } }
    );
  }

  const store = getStore("personal-goals");
  const all = ((await store.get("current", { type: "json" })) || {}) as Record<string, any>;
  if (!all[month] || typeof all[month] !== "object") all[month] = {};

  const record = {
    kind,
    target,
    setAt: new Date().toISOString(),
    setBy: access.email,
  };
  all[month][rep] = record;
  await store.setJSON("current", all);

  return new Response(JSON.stringify({ ok: true, month, rep, goal: record, goals: all[month] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

export const config: Config = {
  path: "/api/personal-goals/set",
};
