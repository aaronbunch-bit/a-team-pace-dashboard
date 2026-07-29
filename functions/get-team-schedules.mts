import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

/** Public read — needed to gate Rebound and show shifts on Individual Pacer. */
export default async (_req: Request, _context: Context) => {
  const store = getStore("team-schedules");
  const data = (await store.get("current", { type: "json" })) || {
    reps: {},
    dailyGoals: {},
  };

  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
};

export const config: Config = {
  path: "/api/team-schedules",
};
