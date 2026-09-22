/** Allowed membership units on Manual Attribution requests (submit / edit). */
export const ALLOWED_ATTR_MEMBERS = [0.5, 1] as const;

/** Cancel-conversion may still reverse a sessions-only cancel (members = 0). */
export const ALLOWED_ATTR_MEMBERS_WITH_ZERO = [0, 0.5, 1] as const;

export function normalizeAttrMembers(value: unknown): number {
  if (value == null || value === "") return NaN;
  const n = Number(value);
  if (!Number.isFinite(n)) return NaN;
  // Tolerate float noise from JSON / inputs (0.5000000002 → 0.5).
  return Math.round(n * 100) / 100;
}

export function isAllowedAttrMembers(
  value: unknown,
  opts?: { allowZero?: boolean }
): boolean {
  const n = normalizeAttrMembers(value);
  if (!Number.isFinite(n)) return false;
  const allowed = opts?.allowZero ? ALLOWED_ATTR_MEMBERS_WITH_ZERO : ALLOWED_ATTR_MEMBERS;
  return (allowed as readonly number[]).includes(n);
}

export function membersValidationError(
  value: unknown,
  opts?: { allowZero?: boolean }
): string | null {
  if (!isAllowedAttrMembers(value, opts)) {
    return opts?.allowZero
      ? "Members must be 0, 0.5, or 1"
      : "Members must be 0.5 or 1";
  }
  return null;
}

/** Normalize client page URL for duplicate matching. */
export function normalizeAttrClientKey(value: unknown): string {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const u = new URL(raw);
    u.hash = "";
    u.search = "";
    const path = u.pathname.replace(/\/+$/, "") || "";
    return (u.origin + path).toLowerCase();
  } catch {
    return raw.replace(/\/+$/, "").toLowerCase();
  }
}

/** Normalize phone/email for duplicate matching. */
export function normalizeAttrContactKey(value: unknown): string {
  const s = String(value || "").trim().toLowerCase();
  if (!s) return "";
  if (s.includes("@")) return s;
  const digits = s.replace(/\D/g, "");
  return digits || s;
}

export type AttrDuplicateMatch = {
  id: string;
  repName: string;
  status: string;
  submittedAt: string | null;
  clientLink: string;
  contact: string;
  matchedOn: "clientLink" | "contact" | "both";
};

/** Find prior Manual Attribution requests for the same client page and/or contact. */
export function findAttrDuplicates(
  records: any[],
  opts: { clientLink?: unknown; contact?: unknown; excludeId?: string }
): AttrDuplicateMatch[] {
  const clientKey = normalizeAttrClientKey(opts.clientLink);
  const contactKey = normalizeAttrContactKey(opts.contact);
  if (!clientKey && !contactKey) return [];

  const out: AttrDuplicateMatch[] = [];
  for (const r of records || []) {
    if (!r || (opts.excludeId && r.id === opts.excludeId)) continue;
    const rClient = normalizeAttrClientKey(r.clientLink);
    const rContact = normalizeAttrContactKey(r.contact);
    const linkHit = !!(clientKey && rClient && clientKey === rClient);
    const contactHit = !!(contactKey && rContact && contactKey === rContact);
    if (!linkHit && !contactHit) continue;
    out.push({
      id: String(r.id || ""),
      repName: String(r.repName || "Rep"),
      status: String(r.status || "pending"),
      submittedAt: r.submittedAt ? String(r.submittedAt) : null,
      clientLink: String(r.clientLink || ""),
      contact: String(r.contact || ""),
      matchedOn: linkHit && contactHit ? "both" : linkHit ? "clientLink" : "contact",
    });
  }
  out.sort((a, b) => String(b.submittedAt || "").localeCompare(String(a.submittedAt || "")));
  return out;
}
