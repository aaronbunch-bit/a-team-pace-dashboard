import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { getIdentityUser } from "./_shared/identity.mts";
import { resolveAccess } from "./_shared/access.mts";
import { CONTEST_STORE, publicContest, type ContestRecord } from "./_shared/contest.mts";

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

  const id = String(body?.id || "").trim();
  if (!id) {
    return new Response(JSON.stringify({ error: "Missing contest id" }), {
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

  const nowIso = new Date().toISOString();
  record.status = "ended";
  record.endedAt = nowIso;
  record.endedBy = access.email;
  record.updatedAt = nowIso;
  await store.setJSON(id, record);

  return new Response(JSON.stringify({ ok: true, contest: publicContest(record) }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
};

export const config: Config = {
  path: "/api/contests/end",
};
