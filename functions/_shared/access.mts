import { getStore } from "@netlify/blobs";

const ADMIN_EMAIL = "aaron.bunch@varsitytutors.com";

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
  /** Permanent primary admin (Aaron) — sole approver / write authority today. */
  isPrimaryAdmin: boolean;
  /** On the shared Admin access list (front-end elevated read). */
  isListedAdmin: boolean;
  /** On the Sales Coach access list (front-end elevated read, no writes). */
  isCoach: boolean;
  /** Can see every rep's Client Detail / Team Details style data. */
  canViewTeam: boolean;
};

/**
 * Resolve elevated-access flags from the caller's email + Blobs lists.
 * Writes still use requirePrimaryAdmin (Aaron only) until Aaron asks for
 * admin-list write parity — see project handoff §6.1.
 */
export async function resolveAccess(email: string | null | undefined): Promise<AccessFlags | null> {
  const normalized = String(email || "").trim().toLowerCase();
  if (!normalized) return null;

  const [admins, coaches] = await Promise.all([
    loadEmailList("admin-list"),
    loadEmailList("coach-list"),
  ]);

  const isPrimaryAdmin = normalized === ADMIN_EMAIL;
  const isListedAdmin = admins.includes(normalized);
  const isCoach = coaches.includes(normalized);

  return {
    email: normalized,
    isPrimaryAdmin,
    isListedAdmin,
    isCoach,
    canViewTeam: isPrimaryAdmin || isListedAdmin || isCoach,
  };
}

export { ADMIN_EMAIL };
