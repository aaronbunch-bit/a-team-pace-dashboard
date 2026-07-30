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
