import assert from "node:assert/strict";
import {
  normalizeTeamMonthSetting,
  normalizeTeamMonthSettingForSave,
  normalizeTeamMonthSettingsDoc,
} from "../functions/_shared/team-month-settings.mts";

const multi = normalizeTeamMonthSetting({
  pgcMetrics: [
    { id: "a", label: " High School ", percent: "42.5" },
    { id: "b", label: "K12 TP", percent: 31 },
    { label: "Overall", percent: -4 },
  ],
});
assert.equal(multi.pgcMetrics.length, 3);
assert.equal(multi.pgcMetrics[0].label, "High School");
assert.equal(multi.pgcMetrics[0].percent, 42.5);
assert.equal(multi.pgcMetrics[2].percent, 0, "pGC percent cannot be negative");
assert.equal(
  normalizeTeamMonthSetting({ pgcMetrics: [{ label: "Bounded", percent: 140 }] }).pgcMetrics[0].percent,
  100,
  "pGC percent cannot exceed 100",
);

const legacy = normalizeTeamMonthSettingForSave({ pgcLabel: " Overall ", pgcValue: "52" });
assert.deepEqual(
  legacy.pgcMetrics.map((m) => ({ label: m.label, percent: m.percent })),
  [{ label: "Overall", percent: 52 }],
  "legacy single pGC becomes one percent metric",
);

assert.deepEqual(
  normalizeTeamMonthSettingForSave({ pgcMetrics: [{ label: "", percent: 0 }] }).pgcMetrics,
  [],
  "empty metrics are dropped on save",
);

const doc = normalizeTeamMonthSettingsDoc({
  "2026-07": { pgcMetrics: [{ label: "K12 TP", percent: 31 }] },
  "2026-08": { pgcLabel: "Overall", pgcValue: 52 },
  invalid: { pgcMetrics: [{ label: "drop me", percent: 999 }] },
});
assert.deepEqual(Object.keys(doc).sort(), ["2026-07", "2026-08"]);
assert.equal(doc["2026-07"].pgcMetrics[0].percent, 31, "prior month remains independent");
assert.equal(doc["2026-08"].pgcMetrics[0].percent, 52, "legacy current month migrates to percent");
assert.equal(doc["2026-08"].pgcMetrics[0].label, "Overall");

console.log("ok — team pGC settings support multiple percent metrics");
