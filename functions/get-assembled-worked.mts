import type { Context, Config } from "@netlify/functions";
import { getIdentityUser } from "./_shared/identity.mts";
import { assembledConfig, assembledGet, chicagoDayBoundsUnix } from "./_shared/assembled.mts";

type Activity = {
  agent_id?: string;
  type_id?: string;
  start_time?: number;
  end_time?: number;
};
type ActivityType = {
  id?: string;
  name?: string;
  productive?: boolean;
  timeoff?: boolean;
};
type Agent = {
  id?: string;
  email?: string;
  agent_email?: string;
  name?: string;
};

/**
 * Who was scheduled to work on a given America/Chicago calendar day, per Assembled.
 * Used to gate Rebound (no badge if they weren't scheduled the prior day).
 *
 * Env: ASSEMBLED_API_KEY (sk_live_…)
 */
export default async (req: Request, context: Context) => {
  if (req.method !== "GET") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
  }

  const user = await getIdentityUser(req, context);
  if (!user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }

  const cfg = assembledConfig();
  if (!cfg) {
    return new Response(
      JSON.stringify({
        configured: false,
        date: null,
        workedEmails: [],
        hint: "Set ASSEMBLED_API_KEY in Netlify env to gate Rebound by schedule",
      }),
      { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } }
    );
  }

  const url = new URL(req.url);
  const date =
    String(url.searchParams.get("date") || "").slice(0, 10) ||
    new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });

  try {
    const { start, end } = chicagoDayBoundsUnix(date);
    const [typesBody, activitiesBody] = await Promise.all([
      assembledGet<{ activity_types?: Record<string, ActivityType> | ActivityType[] }>(
        "/activity_types",
        cfg.apiKey
      ),
      assembledGet<{
        activities?: Record<string, Activity> | Activity[];
        agents?: Record<string, Agent>;
      }>("/activities", cfg.apiKey, {
        start_time: start,
        end_time: end,
        include_agents: true,
        include_activity_types: true,
      }),
    ]);

    const typeMap = new Map<string, ActivityType>();
    const rawTypes = typesBody?.activity_types;
    if (Array.isArray(rawTypes)) {
      rawTypes.forEach((t) => { if (t?.id) typeMap.set(t.id, t); });
    } else if (rawTypes && typeof rawTypes === "object") {
      Object.values(rawTypes).forEach((t) => { if (t?.id) typeMap.set(String(t.id), t); });
    }

    const activities: Activity[] = Array.isArray(activitiesBody?.activities)
      ? activitiesBody.activities
      : Object.values(activitiesBody?.activities || {});

    const agents = activitiesBody?.agents || {};
    const worked = new Set<string>();

    for (const act of activities) {
      const type = act.type_id ? typeMap.get(String(act.type_id)) : null;
      // Never count explicit timeoff as "worked".
      if (type?.timeoff) continue;
      const agent = act.agent_id ? agents[String(act.agent_id)] : null;
      const email = String(agent?.email || agent?.agent_email || "")
        .trim()
        .toLowerCase();
      if (email) worked.add(email);
    }

    // If agents weren't included on activities but we have agent ids, try people list as fallback.
    if (!worked.size && activities.length) {
      const peopleBody = await assembledGet<{ people?: Record<string, any> | any[] }>(
        "/people",
        cfg.apiKey
      );
      const peopleList = Array.isArray(peopleBody?.people)
        ? peopleBody.people
        : Object.values(peopleBody?.people || {});
      const byId = new Map<string, string>();
      peopleList.forEach((p: any) => {
        const id = String(p?.agent_id || p?.id || "");
        const email = String(p?.email || "").trim().toLowerCase();
        if (id && email) byId.set(id, email);
      });
      activities.forEach((act) => {
        const type = act.type_id ? typeMap.get(String(act.type_id)) : null;
        if (type?.timeoff) return;
        const email = byId.get(String(act.agent_id || ""));
        if (email) worked.add(email);
      });
    }

    return new Response(
      JSON.stringify({
        configured: true,
        date,
        timezone: "America/Chicago",
        workedEmails: [...worked].sort(),
        activityCount: activities.length,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      }
    );
  } catch (err: any) {
    console.error("get-assembled-worked failed", err);
    return new Response(
      JSON.stringify({
        configured: true,
        error: err?.message || "Assembled schedule fetch failed",
        date,
        workedEmails: [],
      }),
      { status: 502, headers: { "Content-Type": "application/json" } }
    );
  }
};

export const config: Config = {
  path: "/api/schedules/worked",
};
