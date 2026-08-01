/**
 * Month-crossover badge day rules (Rebound / yesterday).
 * Run: npm run test:badge-day
 *
 * On Aug 1, July 31 sales are not in the live month's items[]. Rebound must
 * not treat that missing coverage as a zero-sale yesterday.
 */
import assert from "node:assert/strict";

function shiftCentralYmd(ymd, n, ymdInTimeZone, timeZone) {
  const [y, m, d] = String(ymd || "").slice(0, 10).split("-").map(Number);
  if (!(y && m && d)) return "";
  const probe = new Date(Date.UTC(y, m - 1, d, 17, 0, 0));
  probe.setUTCDate(probe.getUTCDate() + n);
  return ymdInTimeZone(probe, timeZone);
}

function ymdInTimeZone(date, timeZone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

assert.equal(
  shiftCentralYmd("2026-08-01", -1, ymdInTimeZone, "America/Chicago"),
  "2026-07-31",
  "yesterday from Aug 1 Central is July 31"
);
assert.equal(
  shiftCentralYmd("2026-01-01", -1, ymdInTimeZone, "America/Chicago"),
  "2025-12-31"
);

function hasSalesCoverageForDate(dateStr, liveMonth, prelimMonths, priorBundleMonth) {
  const month = String(dateStr || "").slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(month)) return false;
  if (month === liveMonth) return true;
  if (prelimMonths.includes(month)) return true;
  if (priorBundleMonth === month) return true;
  return false;
}

function hasReboundToday({ todaySales, yestSales, yestCovered, yestOff }) {
  if (yestOff) return false;
  if (!yestCovered) return false;
  return yestSales === 0 && todaySales > 0;
}

assert.equal(
  hasSalesCoverageForDate("2026-07-31", "2026-08", [], null),
  false,
  "without prelim/prior bundle, July is not covered on Aug 1"
);
assert.equal(
  hasReboundToday({ todaySales: 2, yestSales: 0, yestCovered: false, yestOff: false }),
  false,
  "missing yesterday coverage must not award Rebound"
);
assert.equal(
  hasReboundToday({ todaySales: 2, yestSales: 0, yestCovered: true, yestOff: false }),
  true,
  "true Rebound when yesterday is covered and zero"
);
assert.equal(
  hasReboundToday({ todaySales: 2, yestSales: 1, yestCovered: true, yestOff: false }),
  false,
  "sold yesterday → no Rebound"
);
assert.ok(
  hasSalesCoverageForDate("2026-07-31", "2026-08", ["2026-07"], null)
);
assert.ok(
  hasSalesCoverageForDate("2026-07-31", "2026-08", [], "2026-07")
);

console.log("ok — Central yesterday crosses months, and Rebound fails closed without yesterday's ledger");
