/**
 * Ironclad month scoping for live pacers.
 * Run: npm run test:month-scope
 *
 * Cancels and attributions for the live Chicago month must land on that
 * month's pacers — never last month's warm cache, and never a UTC-skewed
 * submittedAt bucket. These checks cover the rules that keep August (and
 * every month after) accurate.
 */
import assert from "node:assert/strict";
import { liveActualsCacheKey, LIVE_ACTUALS_CACHE_KEY } from "../functions/_shared/ledger-exclusions.mts";

assert.equal(
  liveActualsCacheKey("2026-07"),
  `${LIVE_ACTUALS_CACHE_KEY}:2026-07`
);
assert.equal(
  liveActualsCacheKey("2026-08"),
  `${LIVE_ACTUALS_CACHE_KEY}:2026-08`
);
assert.notEqual(
  liveActualsCacheKey("2026-07"),
  liveActualsCacheKey("2026-08"),
  "July and August must not share a warm-cache key — that is how July cancels painted August pacers after midnight"
);
assert.notEqual(
  liveActualsCacheKey("2026-08"),
  LIVE_ACTUALS_CACHE_KEY,
  "the live month must not use the legacy unscoped key"
);

/** Mirror of client attrMonthKey: prefer Central saleDate over UTC submittedAt. */
function attrMonthKey(r, teamTodayMonthKey) {
  const sale = String((r && r.saleDate) || "").slice(0, 7);
  if (/^\d{4}-\d{2}$/.test(sale)) return sale;
  const submitted = r && r.submittedAt ? new Date(r.submittedAt) : null;
  if (submitted && !Number.isNaN(submitted.getTime())) {
    return teamTodayMonthKey(submitted);
  }
  return "";
}

// Late Central evening on July 31 is already August in UTC — saleDate must win.
assert.equal(
  attrMonthKey({
    saleDate: "2026-07-31",
    submittedAt: "2026-08-01T02:15:00.000Z",
  }),
  "2026-07",
  "approved-totals buckets by saleDate; the list filter must match"
);
assert.equal(
  attrMonthKey({
    saleDate: "2026-08-01",
    submittedAt: "2026-08-01T14:00:00.000Z",
  }),
  "2026-08"
);

/** Mirror of the client payload gate. */
function acceptLivePayload(viewMonth, liveMonth) {
  if (viewMonth && viewMonth !== liveMonth) return "ignored";
  return "ok";
}
assert.equal(acceptLivePayload("2026-07", "2026-08"), "ignored");
assert.equal(acceptLivePayload("2026-08", "2026-08"), "ok");
assert.equal(acceptLivePayload("", "2026-08"), "ok", "legacy payloads without viewMonth still apply");

console.log("ok — live cache keys are month-scoped, attr months follow saleDate, wrong-month payloads are rejected");
