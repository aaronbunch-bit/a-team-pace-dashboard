import type { Context, Config } from "@netlify/functions";
import { getIdentityUser } from "./_shared/identity.mts";
import { requireAdmin } from "./_shared/access.mts";
import { runWarehouseSql, warehouseStatus } from "./_shared/warehouse.mts";

/**
 * "Is the connection on?", answerable without reading Netlify logs.
 *
 * A dead warehouse looks exactly like a quiet one from the dashboard: the live
 * feed falls back to the last good numbers behind a one-line status note. This
 * runs a trivial query against whichever engine is active and reports what
 * actually happened, so a missing env var can be told apart from bad
 * credentials, a bad catalog, or a cluster that is simply unreachable.
 *
 * Admin-only: the target string names hosts and catalogs.
 */
export default async (req: Request, context: Context) => {
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);

  const user = await getIdentityUser(req, context);
  const denied = await requireAdmin(user);
  if (denied) return denied;

  const status = warehouseStatus();
  if (!status.configured) {
    return json({
      ok: false,
      ...status,
      reachable: false,
      error: `Not configured — set ${status.missingEnv.join(", ")} in the Netlify site env`,
    });
  }

  const startedAt = Date.now();
  try {
    const rows = await runWarehouseSql<{ ok: number }>("select 1 as ok");
    return json({
      ok: true,
      ...status,
      reachable: true,
      roundTripMs: Date.now() - startedAt,
      rowsReturned: rows.length,
    });
  } catch (err: any) {
    return json({
      ok: false,
      ...status,
      reachable: false,
      roundTripMs: Date.now() - startedAt,
      error: String(err?.message || err),
    });
  }
};

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export const config: Config = {
  path: "/api/warehouse/health",
};
