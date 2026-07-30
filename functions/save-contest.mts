import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { getIdentityUser } from "./_shared/identity.mts";
import { resolveAccess } from "./_shared/access.mts";
import {
  CONTEST_STORE,
  deriveContestStatus,
  newContestId,
  normalizeContestPatch,
  publicContest,
  validateContestFields,
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

  const store = getStore(CONTEST_STORE);
  const id = String(body?.id || "").trim();
  let existing: ContestRecord | null = null;
  if (id) {
    existing = (await store.get(id, { type: "json" })) as ContestRecord | null;
    if (!existing) {
      return new Response(JSON.stringify({ error: "Contest not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  // Visibility-only patch (hide/unhide from History) — skip full field validation.
  if (id && existing && body?.visibilityOnly) {
    existing.hiddenFromHistory = !!body.hiddenFromHistory;
    existing.updatedAt = new Date().toISOString();
    await store.setJSON(id, existing);
    return new Response(JSON.stringify({ ok: true, contest: publicContest(existing) }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }

  const patch = normalizeContestPatch(body, existing);
  const err = validateContestFields(patch);
  if (err) {
    return new Response(JSON.stringify({ error: err }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const now = new Date();
  const nowIso = now.toISOString();
  const nextId = existing?.id || newContestId();

  const record: ContestRecord = {
    id: nextId,
    kind: patch.kind || "hosted",
    name: patch.name || "Contest",
    mode: patch.mode || "race",
    units: patch.units || "sessions",
    stakeType: patch.stakeType || "bragging",
    stakeAmount: patch.stakeAmount ?? null,
    preset: patch.preset || "custom",
    startAt: patch.startAt || nowIso,
    endAt: patch.endAt || nowIso,
    status: existing?.status === "ended" ? "ended" : "scheduled",
    showBanner: patch.showBanner !== false,
    externalUrl: patch.externalUrl ?? null,
    repFilter: patch.repFilter ?? null,
    vehicle: patch.vehicle || "car",
    trackTheme: patch.trackTheme || "asphalt",
    hypeLevel: patch.hypeLevel || "hype",
    accent: patch.accent || "pink",
    raceGoal: patch.raceGoal ?? null,
    tagline: patch.tagline ?? null,
    showLaneBoard: patch.showLaneBoard !== false,
    announcer: patch.announcer !== false,
    wheelSkin: patch.wheelSkin || "classic",
    hiddenFromHistory: !!patch.hiddenFromHistory,
    finalStandings: patch.finalStandings ?? existing?.finalStandings ?? null,
    manualEntries: Array.isArray(existing?.manualEntries) ? existing!.manualEntries : [],
    createdBy: existing?.createdBy || access.email,
    createdAt: existing?.createdAt || nowIso,
    updatedAt: nowIso,
    endedAt: existing?.endedAt ?? null,
    endedBy: existing?.endedBy ?? null,
  };

  // Re-derive unless explicitly ended.
  if (record.status !== "ended") {
    record.status = deriveContestStatus({ ...record, status: "scheduled" }, now);
  }

  // Only one active hosted contest at a time.
  if (record.kind === "hosted" && record.status === "active") {
    const { blobs } = await store.list();
    const all = (
      await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" })))
    ).filter(Boolean) as ContestRecord[];
    for (const other of all) {
      if (other.id === record.id) continue;
      if (other.kind !== "hosted") continue;
      const st = deriveContestStatus(other, now);
      if (st === "active" && other.status !== "ended") {
        other.status = "ended";
        other.endedAt = nowIso;
        other.endedBy = access.email;
        other.updatedAt = nowIso;
        await store.setJSON(other.id, other);
      }
    }
  }

  await store.setJSON(nextId, record);

  return new Response(JSON.stringify({ ok: true, contest: publicContest(record, now) }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
};

export const config: Config = {
  path: "/api/contests/save",
};
