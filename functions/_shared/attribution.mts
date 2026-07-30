/** Allowed membership units on Manual Attribution requests. */
export const ALLOWED_ATTR_MEMBERS = [0, 0.5, 1] as const;

export function normalizeAttrMembers(value: unknown): number {
  if (value == null || value === "") return 0;
  const n = Number(value);
  if (!Number.isFinite(n)) return NaN;
  // Tolerate float noise from JSON / inputs (0.5000000002 → 0.5).
  return Math.round(n * 100) / 100;
}

export function isAllowedAttrMembers(value: unknown): boolean {
  const n = normalizeAttrMembers(value);
  if (!Number.isFinite(n)) return false;
  return (ALLOWED_ATTR_MEMBERS as readonly number[]).includes(n);
}

export function membersValidationError(value: unknown): string | null {
  if (!isAllowedAttrMembers(value)) {
    return "Members must be 0, 0.5, or 1";
  }
  return null;
}
