import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { teamTodayMonthKey } from "./_shared/time.mts";

// Public read — every viewer needs the team's personal goals to render progress
// on Individual Pacer / the coach compiled view (same pattern as badges).
export default async (req: Request, context: Context) => {
  const url = new URL(req.url);
  const month = url.searchParams.get("month") || teamTodayMonthKey();

  const store = getStore("personal-goals");
  const all = (await store.get("current", { type: "json" })) || {};
  const goals = (all && typeof all === "object" && all[month]) || {};

  return new Response(JSON.stringify({ month, goals }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
};

export const config: Config = {
  path: "/api/personal-goals",
};
