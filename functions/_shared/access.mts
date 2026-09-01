import { getStore } from "@netlify/blobs";

const ADMIN_EMAIL = "aaron.bunch@varsitytutors.com";
const PERMANENT_ADMIN_EMAILS = new Set([
  ADMIN_EMAIL,
  "liz.weiss@varsitytutors.com",
]);

async function loadEmailList(storeName: string): Promise<string[]> {
  try {
    const list = await getStore(storeName).get("current", { type: "json" });
    if (!Array.isArray(list)) return [];
    return list.map((e) => String(e || "").trim().toLowerCase()).filter(Boolean);
  } catch {
    return [];
  }
}

export type AccessFlags = {
  email: string;
  /** Primary admin (Aaron). */
  isPrimaryAdmin: boolean;
  /** Hard-coded full admin who cannot be removed through the UI. */
  isPermanentAdmin: boolean;
  /** On the shared Admin access list — same write + read access as Aaron. */
  isListedAdmin: boolean;
  /** Full admin = Aaron OR listed admin (writes, approvals, admin tools). */
  isFullAdmin: boolean;
  /** On the Sales Coach access list (elevated read only — never writes). */
  isCoach: boolean;
  /** Can see every rep's Client Detail / Team Details style data. */
  canViewTeam: boolean;
};

/** Resolve elevated-access flags from permanent admins + shared Blobs lists. */
export async function resolveAccess(email: string | null | undefined): Promise<AccessFlags | null> {
  const normalized = String(email || "").trim().toLowerCase();
  if (!normalized) return null;

  const [admins, coaches] = await Promise.all([
    loadEmailList("admin-list"),
    loadEmailList("coach-list"),
  ]);

  const isPrimaryAdmin = normalized === ADMIN_EMAIL;
  const isPermanentAdmin = PERMANENT_ADMIN_EMAILS.has(normalized);
  const isListedAdmin = admins.includes(normalized);
  const isFullAdmin = isPermanentAdmin || isListedAdmin;
  const isCoach = coaches.includes(normalized);

  return {
    email: normalized,
    isPrimaryAdmin,
    isPermanentAdmin,
    isListedAdmin,
    isFullAdmin,
    isCoach,
    canViewTeam: isFullAdmin || isCoach,
  };
}

/**
 * Gate for every admin write path. Permanent admins always pass; anyone on the
 * shared admin-list Blobs store also passes. Sales Coaches never pass here.
 */
export async function requireAdmin(user: { email?: string } | null): Promise<Response | null> {
  if (!user?.email) {
    return new Response(JSON.stringify({ error: "Not signed in" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  const access = await resolveAccess(user.email);
  if (!access?.isFullAdmin) {
    return new Response(
      JSON.stringify({
        error: `Admin access required. Signed in as ${String(user.email).toLowerCase()}.`,
      }),
      { status: 403, headers: { "Content-Type": "application/json" } }
    );
  }
  return null;
}

export { ADMIN_EMAIL };
