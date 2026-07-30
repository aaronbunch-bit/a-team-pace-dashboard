import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { requireSignedIn } from "./_shared/identity.mts";

/** Identity-gated (@varsitytutors.com) — schedules gate Rebound and show shifts. */
export default async (req: Request, context: Context) => {
  const auth = await requireSignedIn(req, context);
  if (auth.response) return auth.response;

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
