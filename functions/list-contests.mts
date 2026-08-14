import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { requireSignedIn } from "./_shared/identity.mts";
import { resolveAccess } from "./_shared/access.mts";
import { CONTEST_STORE, publicContest, type ContestRecord } from "./_shared/contest.mts";
import { withApiErrors } from "./_shared/api-errors.mts";

export default withApiErrors("list-contests", async (req: Request, context: Context) => {
  const auth = await requireSignedIn(req, context);
  if (auth.response) return auth.response;

  const access = await resolveAccess(auth.user?.email);
  const canManage = !!(access && (access.isFullAdmin || access.isCoach));
  const store = getStore(CONTEST_STORE);
  const { blobs } = await store.list();
  const records = (
    await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" })))
  ).filter(Boolean) as ContestRecord[];

  const now = new Date();
  const url = new URL(req.url);
  // Soft/live polls use scope=active so ended history isn't re-sent every minute.
  // History tab / coach edits still request the full list (default).
  const scope = String(url.searchParams.get("scope") || "all").toLowerCase();
  const contests = records
    .map((c) => publicContest(c, now))
    // Reps never see contests hidden from History; coaches/admins do (to unhide).
    .filter((c) => {
      if (scope === "active") {
        return c.status === "active" || c.status === "scheduled";
      }
      if (!c.hiddenFromHistory) return true;
      if (c.status !== "ended") return true; // hide flag only applies to history
      return canManage;
    })
    .sort((a, b) => String(b.startAt || "").localeCompare(String(a.startAt || "")));

  return new Response(
    JSON.stringify({
      contests,
      canManage,
      scope: scope === "active" ? "active" : "all",
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    }
  );
});

export const config: Config = {
  path: "/api/contests/list",
};
