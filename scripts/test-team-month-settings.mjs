import assert from "node:assert/strict";
import {
  normalizeTeamMonthSetting,
  normalizeTeamMonthSettingsDoc,
} from "../functions/_shared/team-month-settings.mts";

assert.deepEqual(
  normalizeTeamMonthSetting({ pgcLabel: " High School ", pgcValue: "42.5" }),
  { pgcLabel: "High School", pgcValue: 42.5 },
  "pGC saves as a label plus plain number",
);
assert.equal(normalizeTeamMonthSetting({ pgcValue: -4 }).pgcValue, 0, "pGC cannot be negative");
assert.equal(normalizeTeamMonthSetting({ pgcValue: "not a number" }).pgcValue, 0);

const doc = normalizeTeamMonthSettingsDoc({
  "2026-07": { pgcLabel: "K12 TP", pgcValue: 31 },
  "2026-08": { pgcLabel: "Overall", pgcValue: 52 },
  invalid: { pgcLabel: "drop me", pgcValue: 999 },
});
assert.deepEqual(Object.keys(doc).sort(), ["2026-07", "2026-08"]);
assert.equal(doc["2026-07"].pgcValue, 31, "prior month remains independent");
assert.equal(doc["2026-08"].pgcValue, 52, "current month has its own number");

console.log("ok — team pGC settings are numeric and month-scoped");
