import type { Context, Config } from "@netlify/functions";
import { getIdentityUser } from "./_shared/identity.mts";
import { requireAdmin } from "./_shared/access.mts";
import { isMonthKey } from "./_shared/goals.mts";
import {
  loadTeamMonthSettings,
  normalizeTeamMonthSettingForSave,
  saveTeamMonthSettings,
} from "./_shared/team-month-settings.mts";

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

  const month = String(body?.month || "").trim();
  if (!isMonthKey(month)) {
    return new Response(JSON.stringify({ error: "month must be YYYY-MM" }), { status: 400 });
  }

  const settings = await loadTeamMonthSettings();
  settings[month] = normalizeTeamMonthSettingForSave({
    pgcMetrics: body?.pgcMetrics,
    // Legacy single-metric payloads still accepted during rollout.
    pgcLabel: body?.pgcLabel,
    pgcValue: body?.pgcValue,
  });
  await saveTeamMonthSettings(settings);

  return new Response(JSON.stringify({ ok: true, month, setting: settings[month], settings }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

export const config: Config = {
  path: "/api/team-month-settings/update",
};
