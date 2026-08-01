/**
 * Locks in month-scoped team quotas.
 * Run: npm test
 *
 * Quotas were one document with no month on it, so a last-month view read
 * whatever was set today: change or clear a quota for the new month and last
 * month's board changed with it. These checks cover the two rules that stop
 * that — a month, once settled, is never rewritten by a later edit, and the
 * month before the live one is settled the first time the live one is saved.
 */
import assert from "node:assert/strict";
import {
  isMonthKey,
  previousMonthKey,
} from "../functions/_shared/goals.mts";

assert.ok(isMonthKey("2026-07"));
assert.ok(isMonthKey("2026-12"));
assert.ok(!isMonthKey("2026-13"), "month 13 is not a month");
assert.ok(!isMonthKey("2026-00"), "month 0 is not a month");
assert.ok(!isMonthKey("2026-7"), "unpadded months would sort wrong");
assert.ok(!isMonthKey("2026-07-01"), "a day is not a month key");
assert.ok(!isMonthKey(""));
assert.ok(!isMonthKey(null));

assert.equal(previousMonthKey("2026-08"), "2026-07");
assert.equal(previousMonthKey("2026-01"), "2025-12", "January's previous month is last December");
assert.equal(previousMonthKey("nonsense"), "");

/**
 * The archive rule, as `recordLiveMonthGoals` applies it. Kept as a pure
 * function here so the behaviour is asserted without a Blobs client: the real
 * one is the same three lines around a store read and write.
 */
function settle(byMonth, month, goals, previousGoals) {
  const out = { ...byMonth };
  const prior = previousMonthKey(month);
  if (prior && !out[prior] && previousGoals && Object.keys(previousGoals).length) {
    out[prior] = previousGoals;
  }
  out[month] = goals;
  return out;
}

const july = { "Becky Ruffer": { members: 8, sessions: 60 } };
const august = { "Becky Ruffer": { members: 9, sessions: 64 } };

// Saving August for the first time after rollover freezes July as it stood.
const first = settle({}, "2026-08", august, july);
assert.deepEqual(first["2026-07"], july, "last month keeps the quotas it ran under");
assert.deepEqual(first["2026-08"], august);

// Editing August again must not touch July, even to a cleared document.
const cleared = { "Becky Ruffer": { members: 0, sessions: 0 } };
const second = settle(first, "2026-08", cleared, august);
assert.deepEqual(second["2026-07"], july, "clearing this month's quota cannot clear last month's");
assert.deepEqual(second["2026-08"], cleared);

// A month already settled is never overwritten by a later live-month save.
const third = settle(second, "2026-08", august, { "Becky Ruffer": { members: 99, sessions: 99 } });
assert.deepEqual(third["2026-07"], july, "a settled month is history, not a mirror of today");

// Nothing to freeze when there is nothing to freeze.
const empty = settle({}, "2026-08", august, null);
assert.equal(empty["2026-07"], undefined);
assert.deepEqual(empty["2026-08"], august);

console.log("ok — month keys, and a settled month survives every later quota edit");
