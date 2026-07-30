import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { getIdentityUser } from "./_shared/identity.mts";
import { resolveAccess } from "./_shared/access.mts";
import {
  CONTEST_STORE,
  assignManualDealPick,
  mergeDealPicksFromSales,
  migrateContestMode,
  normalizeDealCases,
  normalizeDealPicks,
  publicContest,
  shuffleDealValues,
  type ContestRecord,
  type DealSaleInput,
} from "./_shared/contest.mts";

function normalizeSales(raw: any): DealSaleInput[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((s: any) => ({
      saleKey: String(s?.saleKey || "").trim().slice(0, 160),
      repName: String(s?.repName || "").trim().slice(0, 80),
      at: String(s?.at || "").trim() || new Date().toISOString(),
    }))
    .filter((s) => s.saleKey && s.repName)
    .slice(0, 200);
}

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

  const action = String(body?.action || "sync").trim();
  const access = await resolveAccess(user.email);
  const isCoach = !!(access && (access.isFullAdmin || access.isCoach));

  // Syncing sales is open to any signed-in teammate (keeps the board honest as
  // ledger updates land). Manual picks stay coach/admin-only.
  if (action === "pick" && !isCoach) {
    return new Response(JSON.stringify({ error: "Coach or admin access required" }), {
      status: 403,
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

  if (migrateContestMode(record.mode) !== "deal") {
    return new Response(JSON.stringify({ error: "Only Deal or No Deal contests use case picks" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  let cases = normalizeDealCases(record.dealCases);
  if (!cases || !cases.length) {
    cases = shuffleDealValues();
    record.dealCases = cases;
  }

  const nowIso = new Date().toISOString();
  let picks = normalizeDealPicks(record.dealPicks);
  let assignedPick = null as ReturnType<typeof assignManualDealPick>["pick"];

  if (action === "pick") {
    const result = assignManualDealPick(cases, picks, String(body?.repName || ""), access!.email, nowIso);
    if (result.error) {
      return new Response(JSON.stringify({ error: result.error }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    picks = result.picks;
    assignedPick = result.pick;
  } else {
    // Default: sync sale-driven picks (and optional coach sales payload).
    picks = mergeDealPicksFromSales(cases, picks, normalizeSales(body?.sales));
  }

  record.dealCases = cases;
  record.dealPicks = picks;
  record.updatedAt = nowIso;
  await store.setJSON(id, record);

  return new Response(
    JSON.stringify({
      ok: true,
      contest: publicContest(record),
      pick: assignedPick,
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    },
  );
};

export const config: Config = {
  path: "/api/contests/deal-pick",
};
