import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { requireSignedIn } from "./_shared/identity.mts";
import {
  CONTEST_STORE,
  deriveContestStatus,
  normalizeFinalStandings,
  publicContest,
  type ContestRecord,
} from "./_shared/contest.mts";

/**
 * Freeze a leaderboard snapshot for an ended contest that has none yet.
 * Any signed-in user can freeze once so History stays accurate after the window closes.
 */
export default async (req: Request, context: Context) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
  }

  const auth = await requireSignedIn(req, context);
  if (auth.response) return auth.response;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid request body" }), { status: 400 });
  }

  const id = String(body?.id || "").trim();
  if (!id) {
    return new Response(JSON.stringify({ error: "Missing contest id" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const snap = normalizeFinalStandings(body?.finalStandings);
  if (!snap) {
    return new Response(JSON.stringify({ error: "finalStandings required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const store = getStore(CONTEST_STORE);
  const record = (await store.get(id, { type: "json" })) as ContestRecord | null;
  if (!record) {
    return new Response(JSON.stringify({ error: "Contest not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  const now = new Date();
  const status = deriveContestStatus(record, now);
  if (status !== "ended" && record.status !== "ended") {
    return new Response(JSON.stringify({ error: "Contest is still running" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (Array.isArray(record.finalStandings) && record.finalStandings.length) {
    return new Response(JSON.stringify({ ok: true, contest: publicContest(record, now), already: true }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }

  record.finalStandings = snap;
  if (record.status !== "ended") {
    record.status = "ended";
    record.endedAt = record.endedAt || now.toISOString();
  }
  record.updatedAt = now.toISOString();
  await store.setJSON(id, record);

  return new Response(JSON.stringify({ ok: true, contest: publicContest(record, now) }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
};

export const config: Config = {
  path: "/api/contests/freeze-standings",
};
