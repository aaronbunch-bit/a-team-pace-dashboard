import type { Context, Config } from "@netlify/functions";
import { getIdentityUser, requireSignedIn } from "./_shared/identity.mts";
import { requireAdmin, resolveAccess } from "./_shared/access.mts";
import {
  type LedgerExclusion,
  invalidateLiveActualsCache,
  loadLedgerExclusionList,
  saveLedgerExclusionList,
} from "./_shared/ledger-exclusions.mts";

/**
 * Exclude (or restore) a Supabase ledger row from the pacer's totals.
 *
 * Supabase is read-only here, so this is the only way to retire a duplicate
 * credit line: `get-live-actuals` drops excluded ledger ids before totalling.
 * Reads are open to anyone signed in (the Ops review list); writes are admins
 * only, and every entry records who excluded it and why.
 */
export default async (req: Request, context: Context) => {
  if (req.method === "GET") {
    const auth = await requireSignedIn(req, context);
    if (auth.response) return auth.response;
    const access = await resolveAccess(auth.user.email);
    return json({ ok: true, exclusions: await loadLedgerExclusionList(), canEdit: !!access?.isFullAdmin });
  }

  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const user = await getIdentityUser(req, context);
  const adminError = await requireAdmin(user);
  if (adminError) return adminError;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid request body" }, 400);
  }

  const ledgerId = String(body?.ledgerId || "").trim();
  if (!ledgerId) return json({ error: "Missing ledgerId" }, 400);

  const action = String(body?.action || "exclude").trim().toLowerCase();
  if (action !== "exclude" && action !== "restore") {
    return json({ error: "action must be 'exclude' or 'restore'" }, 400);
  }

  const note = String(body?.note || "").trim();
  if (action === "exclude" && !note) {
    return json({ error: "A note is required so the correction is auditable" }, 400);
  }

  const current = await loadLedgerExclusionList();
  let next: LedgerExclusion[];
  if (action === "restore") {
    next = current.filter((entry) => entry.ledgerId !== ledgerId);
    if (next.length === current.length) {
      return json({ error: "That ledger row is not excluded" }, 404);
    }
  } else {
    if (current.some((entry) => entry.ledgerId === ledgerId)) {
      return json({ error: "That ledger row is already excluded" }, 409);
    }
    next = [
      ...current,
      {
        ledgerId,
        clientId: String(body?.clientId || "").trim(),
        repName: String(body?.repName || "").trim(),
        note,
        excludedBy: String(user?.email || "").toLowerCase(),
        excludedAt: new Date().toISOString(),
      },
    ];
  }

  await saveLedgerExclusionList(next);
  await invalidateLiveActualsCache();

  return json({ ok: true, action, ledgerId, exclusions: next });
};

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export const config: Config = {
  path: "/api/ledger/exclusions",
};
