import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { teamTodayMonthKey } from "./_shared/time.mts";

// Deliberately PUBLIC / no auth check — every viewer of the dashboard needs these
// aggregate numbers to see accurate pace, not just the rep who submitted them or
// the admin. Only approved totals per rep are exposed here; the underlying
// request details (client IDs, reasons, who submitted) stay behind the
// Identity-gated list/review endpoints.
export default async (req: Request, context: Context) => {
  const url = new URL(req.url);
  const month = url.searchParams.get("month"); // "YYYY-MM"; defaults to current month
  const targetMonth = month || teamTodayMonthKey();

  const store = getStore("manual-attributions");
  const { blobs } = await store.list();
  const records = (await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" })))).filter(Boolean);

  const totals: Record<string, { members: number; sessions: number }> = {};
  for (const r of records as any[]) {
    if (r.status !== "approved") continue;
    if (String(r.saleDate || "").slice(0, 7) !== targetMonth) continue;
    if (!totals[r.repName]) totals[r.repName] = { members: 0, sessions: 0 };
    totals[r.repName].members += r.members;
    totals[r.repName].sessions += r.sessions;
  }

  return new Response(JSON.stringify({ month: targetMonth, totals }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

export const config: Config = {
  path: "/api/attributions/approved-totals",
};
