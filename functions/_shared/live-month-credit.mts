/**
 * Live MTD month-window helpers (America/Chicago business month).
 *
 * Sales (and same-month revisions) enter via attribution occurred_at.
 * Cancels of prior-month sales enter via ledger created_at when the line is
 * negative — so a cancel that *hits* in July reduces July MTD even when the
 * original sale was June.
 */

export type MonthCreditInput = {
  /** Attribution sale/cancel occurred_at (UTC ms). */
  occurredAtMs: number;
  /** Ledger row created_at (UTC ms). */
  ledgerCreatedAtMs: number;
  members: number;
  sessions: number;
  monthStartMs: number;
  monthEndMs: number;
};

/** Whether a ledger row belongs in the live MTD month window. */
export function ledgerRowInLiveMonth(row: MonthCreditInput): boolean {
  const { occurredAtMs, ledgerCreatedAtMs, members, sessions, monthStartMs, monthEndMs } = row;
  if (occurredAtMs >= monthStartMs && occurredAtMs < monthEndMs) return true;
  const isCancel = members < 0 || sessions < 0;
  if (
    isCancel &&
    ledgerCreatedAtMs >= monthStartMs &&
    ledgerCreatedAtMs < monthEndMs
  ) {
    return true;
  }
  return false;
}

/**
 * Which timestamp drives the item date / as-of for a row already in the month.
 * In-month attributions keep occurred_at; prior-sale cancels that hit this
 * month use ledger created_at.
 */
export function liveMonthCreditAtMs(row: MonthCreditInput): number {
  if (row.occurredAtMs >= row.monthStartMs && row.occurredAtMs < row.monthEndMs) {
    return row.occurredAtMs;
  }
  return row.ledgerCreatedAtMs;
}
