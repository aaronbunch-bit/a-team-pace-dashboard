import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { requireSignedIn } from "./_shared/identity.mts";
import { resolveAccess } from "./_shared/access.mts";
import { CONTEST_STORE, publicContest, type ContestRecord } from "./_shared/contest.mts";

export default async (req: Request, context: Context) => {
  const auth = await requireSignedIn(req, context);
  if (auth.response) return auth.response;

  const access = await resolveAccess(auth.user?.email);
  const store = getStore(CONTEST_STORE);
  const { blobs } = await store.list();
  const records = (
    await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" })))
  ).filter(Boolean) as ContestRecord[];

  const now = new Date();
  const contests = records
    .map((c) => publicContest(c, now))
    .sort((a, b) => String(b.startAt || "").localeCompare(String(a.startAt || "")));

  return new Response(
    JSON.stringify({
      contests,
      canManage: !!(access && (access.isFullAdmin || access.isCoach)),
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    }
  );
};

export const config: Config = {
  path: "/api/contests/list",
};
