/**
 * Lightweight assertions for July-hit cancel month inclusion.
 * Run: node scripts/test-live-month-credit.mjs
 */
import assert from "node:assert/strict";

// Mirror functions/_shared/live-month-credit.mts (JS copy for zero-build test).
function ledgerRowInLiveMonth(row) {
  const { occurredAtMs, ledgerCreatedAtMs, members, sessions, monthStartMs, monthEndMs } = row;
  if (occurredAtMs >= monthStartMs && occurredAtMs < monthEndMs) return true;
  const isCancel = members < 0 || sessions < 0;
  if (isCancel && ledgerCreatedAtMs >= monthStartMs && ledgerCreatedAtMs < monthEndMs) {
    return true;
  }
  return false;
}

function liveMonthCreditAtMs(row) {
  if (row.occurredAtMs >= row.monthStartMs && row.occurredAtMs < row.monthEndMs) {
    return row.occurredAtMs;
  }
  return row.ledgerCreatedAtMs;
}

// July 2026 Chicago ≈ 2026-07-01 05:00 UTC → 2026-08-01 05:00 UTC (CDT)
const monthStartMs = Date.parse("2026-07-01T05:00:00.000Z");
const monthEndMs = Date.parse("2026-08-01T05:00:00.000Z");

const julySale = {
  occurredAtMs: Date.parse("2026-07-15T18:00:00.000Z"),
  ledgerCreatedAtMs: Date.parse("2026-07-15T18:01:00.000Z"),
  members: 1,
  sessions: 8,
  monthStartMs,
  monthEndMs,
};
assert.equal(ledgerRowInLiveMonth(julySale), true);
assert.equal(liveMonthCreditAtMs(julySale), julySale.occurredAtMs);

const julyOriginCancel = {
  occurredAtMs: Date.parse("2026-07-10T16:00:00.000Z"),
  ledgerCreatedAtMs: Date.parse("2026-07-20T16:00:00.000Z"),
  members: -1,
  sessions: -8,
  monthStartMs,
  monthEndMs,
};
assert.equal(ledgerRowInLiveMonth(julyOriginCancel), true);
assert.equal(liveMonthCreditAtMs(julyOriginCancel), julyOriginCancel.occurredAtMs);

// Prior-month sale cancel that HITS in July — the CSV gap case.
const priorSaleJulyHitCancel = {
  occurredAtMs: Date.parse("2026-06-12T16:00:00.000Z"),
  ledgerCreatedAtMs: Date.parse("2026-07-02T17:21:47.000Z"),
  members: -1,
  sessions: -8,
  monthStartMs,
  monthEndMs,
};
assert.equal(ledgerRowInLiveMonth(priorSaleJulyHitCancel), true);
assert.equal(liveMonthCreditAtMs(priorSaleJulyHitCancel), priorSaleJulyHitCancel.ledgerCreatedAtMs);

// Prior-month cancel that does NOT hit in July — stay out.
const juneCancel = {
  occurredAtMs: Date.parse("2026-06-12T16:00:00.000Z"),
  ledgerCreatedAtMs: Date.parse("2026-06-20T16:00:00.000Z"),
  members: -1,
  sessions: -8,
  monthStartMs,
  monthEndMs,
};
assert.equal(ledgerRowInLiveMonth(juneCancel), false);

// Positive prior-month sale must not leak into July via created_at.
const juneSale = {
  occurredAtMs: Date.parse("2026-06-12T16:00:00.000Z"),
  ledgerCreatedAtMs: Date.parse("2026-07-02T17:00:00.000Z"),
  members: 1,
  sessions: 8,
  monthStartMs,
  monthEndMs,
};
assert.equal(ledgerRowInLiveMonth(juneSale), false);

// Sessions-only cancel hitting in July.
const sessionsOnly = {
  occurredAtMs: Date.parse("2026-05-01T12:00:00.000Z"),
  ledgerCreatedAtMs: Date.parse("2026-07-18T12:00:00.000Z"),
  members: 0,
  sessions: -4,
  monthStartMs,
  monthEndMs,
};
assert.equal(ledgerRowInLiveMonth(sessionsOnly), true);

console.log("ok — live month credit inclusion");
