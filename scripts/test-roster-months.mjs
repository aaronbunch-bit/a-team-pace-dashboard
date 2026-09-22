/**
 * Locks in month-scoped roster history.
 * Run: npm test
 *
 * The live roster is one list with an `active` flag. Without a per-month
 * archive, removing someone in the new month also erased them from last month's
 * boards. These checks cover the settle rule: the first live-month save freezes
 * the prior month with everyone active, and later edits never rewrite it.
 */
import assert from "node:assert/strict";
import { previousMonthKey } from "../functions/_shared/goals.mts";
import { normalizeRosterEntries } from "../functions/_shared/roster-months.mts";

assert.equal(previousMonthKey("2026-08"), "2026-07");

function settle(byMonth, month, roster, previousRoster) {
  const out = { ...byMonth };
  const prior = previousMonthKey(month);
  if (prior && !out[prior] && previousRoster && previousRoster.length) {
    out[prior] = normalizeRosterEntries(previousRoster).map((r) => ({
      ...r,
      active: true,
    }));
  }
  out[month] = normalizeRosterEntries(roster);
  return out;
}

const julyLive = [
  { display: "Becky Ruffer", csv: "becky ruffer", active: true },
  { display: "Chris Jones", csv: "chris jones", active: true },
];
const augustLive = [
  { display: "Becky Ruffer", csv: "becky ruffer", active: true },
  { display: "Chris Jones", csv: "chris jones", active: false },
];

const first = settle({}, "2026-08", augustLive, julyLive);
assert.equal(first["2026-07"].length, 2);
assert.ok(first["2026-07"].every((r) => r.active === true), "first freeze keeps everyone on last month");
assert.equal(first["2026-08"].find((r) => r.display === "Chris Jones").active, false);

const second = settle(first, "2026-08", [
  { display: "Becky Ruffer", csv: "becky ruffer", active: true },
], augustLive);
assert.equal(second["2026-07"].length, 2, "later roster edits must not rewrite last month");
assert.ok(second["2026-07"].some((r) => r.display === "Chris Jones"));
assert.equal(second["2026-08"].length, 1);

const alreadyInactive = [
  { display: "Becky Ruffer", csv: "becky ruffer", active: true },
  { display: "Chris Jones", csv: "chris jones", active: false },
];
const lateDeploy = settle({}, "2026-08", alreadyInactive, alreadyInactive);
assert.ok(
  lateDeploy["2026-07"].find((r) => r.display === "Chris Jones").active,
  "even if they were already removed before the archive existed, last month still lists them"
);

console.log("ok — settled roster months keep removed reps on last month's board");
