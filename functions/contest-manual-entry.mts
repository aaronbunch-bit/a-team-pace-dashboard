import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { getIdentityUser } from "./_shared/identity.mts";
import { resolveAccess } from "./_shared/access.mts";
import { loadValidRepDisplays } from "./_shared/roster.mts";
import {
  CONTEST_STORE,
  newManualEntryId,
  publicContest,
  type ContestRecord,
} from "./_shared/contest.mts";

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

  const contestId = String(body?.contestId || body?.id || "").trim();
  const repName = String(body?.repName || "").trim();
  const note = String(body?.note || "").trim().slice(0, 280);
  const sessions = Number(body?.sessions) || 0;
  const members = Number(body?.members) || 0;

  if (!contestId) {
    return new Response(JSON.stringify({ error: "Missing contest id" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (!repName) {
    return new Response(JSON.stringify({ error: "Pick a rep" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (!note) {
    return new Response(JSON.stringify({ error: "Add a short note for the audit trail" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (sessions === 0 && members === 0) {
    return new Response(JSON.stringify({ error: "Enter sessions and/or members to add" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const validReps = await loadValidRepDisplays();
  if (!validReps.has(repName)) {
    return new Response(JSON.stringify({ error: "Unknown rep" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const store = getStore(CONTEST_STORE);
  const record = (await store.get(contestId, { type: "json" })) as ContestRecord | null;
  if (!record) {
    return new Response(JSON.stringify({ error: "Contest not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  const entry = {
    id: newManualEntryId(),
    repName,
    sessions,
    members,
    note,
    by: access.email,
    at: new Date().toISOString(),
  };
  record.manualEntries = Array.isArray(record.manualEntries) ? record.manualEntries : [];
  record.manualEntries.push(entry);
  record.updatedAt = entry.at;
  await store.setJSON(contestId, record);

  return new Response(
    JSON.stringify({ ok: true, entry, contest: publicContest(record) }),
    {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    }
  );
};

export const config: Config = {
  path: "/api/contests/manual-entry",
};
