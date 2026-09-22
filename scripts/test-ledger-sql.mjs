/**
 * Parses the SQL the live query generates.
 * Run: npm test
 *
 * The month key and the credits join are built as strings from whatever columns
 * `sales_attribution.credits` turns out to have, so a schema the code has never
 * seen can produce SQL that does not parse — and the only symptom is a live feed
 * that quietly falls back. libpg_query is the real Postgres grammar, so this
 * catches that before a deploy does.
 */
import assert from "node:assert/strict";
import { buildCreditJoinPlan, liveMonthKeyExpr } from "../functions/get-live-actuals.mts";

let Parser;
try {
  ({ default: Parser } = await import("pg-query-emscripten"));
} catch {
  console.log(
    "SKIPPED — pg-query-emscripten is not installed. Run `npm run test:sql:install` to enable this test."
  );
  process.exit(0);
}

const parser = await new Parser();

function parses(sql, label) {
  const { error } = parser.parse(sql);
  assert.equal(error, null, `${label} must parse — ${error?.message || ""}\n${sql}`);
}

// Guard the guard: a query this test would wave through proves nothing.
assert.notEqual(parser.parse("select from where;").error, null, "the parser must reject bad SQL");

/** The month key only ever appears inside a select list and a where clause. */
function queryUsing(monthKey, extraSelect = "") {
  return `
select ${monthKey} as month_key${extraSelect}
from sales_attribution.rep_scores_ledger_entries l
left join sales_attribution.credits c on c.id::text = btrim(l.credit_id)
where ${monthKey} >= timestamp '2026-08-01' and ${monthKey} < timestamp '2026-09-01';
`;
}

const TZ = "America/Chicago";

// The shape the project actually has: a credit id plus occurrence and
// cancellation timestamps.
const full = buildCreditJoinPlan(
  [
    { name: "id", type: "uuid" },
    { name: "occurred_at", type: "timestamp with time zone" },
    { name: "cancelled_at", type: "timestamp with time zone" },
    { name: "created_at", type: "timestamp with time zone" },
    { name: "deleted_at", type: "timestamp with time zone" },
    { name: "business_date", type: "date" },
  ],
  TZ
);
assert.equal(full.enabled, true);
parses(queryUsing(liveMonthKeyExpr(full)), "month key over a full credits schema");
parses(queryUsing("l.created_at", `,\n  ${full.onClause} as matched`), "credit join on-clause");
parses(
  queryUsing(
    "l.created_at",
    `,\n  ${full.businessDateExpr} as business_date,\n  ${full.occurredDateExpr} as occurred_date`
  ),
  "credit day expressions"
);

// A cancelled credit must not drag the credit line out of the month it was
// earned in, so the occurrence expression may never read a cancellation column.
assert.match(full.businessAtExpr, /cancelled_at/, "cancels still prefer the cancellation day");
assert.doesNotMatch(full.occurredAtExpr, /cancelled_at/);
assert.doesNotMatch(full.occurredDateExpr, /cancelled_at/);
assert.match(full.occurredAtExpr, /occurred_at/, "credits are dated by when they occurred");
// deleted_at is a soft delete, never a business day.
assert.doesNotMatch(String(full.businessAtExpr), /deleted_at/);
assert.doesNotMatch(String(full.occurredAtExpr), /deleted_at/);

// Credits with an id but no date at all: every expression is null and the key
// falls back to the ledger's own timestamp rather than emitting `coalesce()`.
const idOnly = buildCreditJoinPlan([{ name: "id", type: "uuid" }], TZ);
assert.equal(idOnly.businessAtExpr, null);
assert.equal(idOnly.occurredAtExpr, null);
assert.equal(liveMonthKeyExpr(idOnly), "l.created_at");
parses(queryUsing(liveMonthKeyExpr(idOnly)), "month key with no credit dates");

// Only a cancellation column: negatives use it, positives still fall back, and
// the emitted CASE must parse with one branch defaulting.
const cancelOnly = buildCreditJoinPlan(
  [
    { name: "id", type: "uuid" },
    { name: "cancelled_at", type: "timestamp with time zone" },
  ],
  TZ
);
assert.equal(cancelOnly.occurredAtExpr, null, "a cancellation day is not an occurrence day");
const cancelOnlyKey = liveMonthKeyExpr(cancelOnly);
assert.match(cancelOnlyKey, /else l\.created_at/, "positive lines keep the ledger timestamp");
parses(queryUsing(cancelOnlyKey), "month key with only a cancellation column");

// A date-typed occurrence column has to be lifted into the team zone before it
// can be compared against the month bounds.
const dateOnly = buildCreditJoinPlan(
  [
    { name: "id", type: "uuid" },
    { name: "business_date", type: "date" },
  ],
  TZ
);
parses(queryUsing(liveMonthKeyExpr(dateOnly)), "month key over a date column");

// No usable id column: the join is off and nothing may reference alias `c`.
const noId = buildCreditJoinPlan([{ name: "occurred_at", type: "timestamp with time zone" }], TZ);
assert.equal(noId.enabled, false);
assert.equal(liveMonthKeyExpr(noId), "l.created_at", "an unjoinable credits table changes nothing");

console.log("ok — generated month-key and credit-join SQL parses, and credit dates exclude cancellations");
