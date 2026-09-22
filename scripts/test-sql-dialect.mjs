/**
 * The generated ledger SQL, in both engines' grammar.
 * Run: npm test
 *
 * Two things have to stay true at once. The Postgres rendering must be exactly
 * what shipped before the Starburst work — the Supabase path is the one serving
 * live pace, and a stray cast there is a silent outage. The Trino rendering
 * must avoid the Postgres-only constructs (`::cast`, `left()`, `btrim()`,
 * `interval '1 month'`) that a Trino cluster rejects outright.
 */
import assert from "node:assert/strict";
import {
  postgresDialect,
  trinoDialect,
  normalizeTrinoColumnType,
} from "../functions/_shared/sql-dialect.mts";
import {
  buildCreditJoinPlan,
  liveMonthKeyExpr,
  monthBoundsCte,
  candidateDayExpr,
} from "../functions/get-live-actuals.mts";
import { starburstBaseUrl } from "../functions/_shared/starburst.mts";

const TZ = "America/Chicago";
const pg = postgresDialect;
const trino = trinoDialect({ catalog: "hive", schema: "sales_attribution" });

// ---- Postgres renders exactly what it always did ---------------------------
assert.equal(pg.text("l.id"), "l.id::text");
assert.equal(pg.float("l.hours_amount"), "l.hours_amount::float8");
assert.equal(pg.nullText(), "null::text");
assert.equal(pg.trim("l.credit_id"), "btrim(l.credit_id)");
assert.equal(pg.leftText("c.business_date", 10), "left((c.business_date)::text, 10)");
assert.equal(pg.interval(1, "month"), "interval '1 month'");
assert.equal(pg.interval(5, "second"), "interval '5 seconds'");
assert.equal(
  pg.zonedTimestampLiteral("2026-09-01", TZ),
  "(timestamp '2026-09-01' at time zone 'America/Chicago')"
);
assert.equal(
  pg.dayTextFromInstant("l.created_at", TZ),
  "(l.created_at at time zone 'America/Chicago')::date::text"
);
assert.equal(
  pg.zonedText("l.created_at", TZ),
  "(l.created_at at time zone 'America/Chicago')::text"
);
assert.equal(
  pg.dateToInstant("c.business_date", TZ),
  "(c.business_date::timestamp at time zone 'America/Chicago')"
);
assert.equal(pg.table("credits"), "sales_attribution.credits");
assert.equal(pg.informationSchema("columns"), "information_schema.columns");

// ---- Trino avoids every Postgres-only construct -----------------------------
const trinoFragments = [
  trino.text("l.id"),
  trino.float("l.hours_amount"),
  trino.nullText(),
  trino.trim("l.credit_id"),
  trino.leftText("c.business_date", 10),
  trino.interval(1, "month"),
  trino.interval(5, "second"),
  trino.zonedTimestampLiteral("2026-09-01", TZ),
  trino.dayTextFromInstant("l.created_at", TZ),
  trino.dayTextFromLocal("l.created_at", TZ),
  trino.zonedText("l.created_at", TZ),
  trino.dateToInstant("c.business_date", TZ),
];
for (const fragment of trinoFragments) {
  assert.doesNotMatch(fragment, /::/, `Trino must not emit a Postgres cast: ${fragment}`);
  assert.doesNotMatch(fragment, /\bbtrim\(/, `Trino has no btrim(): ${fragment}`);
  assert.doesNotMatch(fragment, /\bleft\(/, `Trino has no left(): ${fragment}`);
}
assert.equal(trino.text("l.id"), "cast(l.id as varchar)");
assert.equal(trino.interval(1, "month"), "interval '1' MONTH");
assert.equal(trino.interval(5, "second"), "interval '5' SECOND");
assert.equal(
  trino.zonedTimestampLiteral("2026-09-01", TZ),
  "with_timezone(timestamp '2026-09-01', 'America/Chicago')"
);
// A zone-less timestamp cannot take AT TIME ZONE in Trino — it must be lifted.
assert.match(trino.dayTextFromLocal("l.created_at", TZ), /with_timezone\(l\.created_at/);
assert.match(trino.dayTextFromInstant("l.created_at", TZ), /at time zone 'America\/Chicago'/);
assert.equal(trino.table("credits"), "hive.sales_attribution.credits");
assert.equal(trino.informationSchema("tables"), "hive.information_schema.tables");
assert.throws(() => trinoDialect({ catalog: "", schema: "x" }), /catalog and a schema/);

// ---- Trino type names normalize onto the month-key probe's vocabulary -------
// Left untranslated, `timestamp(6) with time zone` matches nothing and the
// query ships with no candidate dates and no credits join.
assert.equal(normalizeTrinoColumnType("timestamp(6) with time zone"), "timestamp with time zone");
assert.equal(normalizeTrinoColumnType("timestamp(3)"), "timestamp without time zone");
assert.equal(normalizeTrinoColumnType("varchar(255)"), "text");
assert.equal(normalizeTrinoColumnType("varchar"), "text");
assert.equal(normalizeTrinoColumnType("decimal(10,2)"), "numeric");
assert.equal(normalizeTrinoColumnType("double"), "double precision");
assert.equal(normalizeTrinoColumnType("date"), "date");
assert.equal(normalizeTrinoColumnType("bigint"), "bigint");

// ---- The credits join plan renders in both grammars ------------------------
const creditCols = [
  { name: "id", type: "uuid" },
  { name: "occurred_at", type: "timestamp with time zone" },
  { name: "cancelled_at", type: "timestamp with time zone" },
  { name: "business_date", type: "date" },
];

const pgPlan = buildCreditJoinPlan(creditCols, TZ);
// Unchanged from the shipped Postgres query.
assert.equal(pgPlan.enabled, true);
assert.match(pgPlan.onClause, /c\.id::text = btrim\(l\.credit_id\)/);
assert.match(pgPlan.businessDateExpr, /at time zone 'America\/Chicago'\)::date::text/);
assert.match(liveMonthKeyExpr(pgPlan), /else coalesce/);

const trinoPlan = buildCreditJoinPlan(creditCols, TZ, trino);
assert.equal(trinoPlan.enabled, true);
assert.equal(trinoPlan.idColumns.join(","), pgPlan.idColumns.join(","), "same join columns");
assert.match(trinoPlan.onClause, /cast\(c\.id as varchar\) = trim\(l\.credit_id\)/);
for (const expr of [
  trinoPlan.onClause,
  trinoPlan.businessDateExpr,
  trinoPlan.businessAtExpr,
  trinoPlan.occurredDateExpr,
  trinoPlan.occurredAtExpr,
  liveMonthKeyExpr(trinoPlan),
]) {
  assert.doesNotMatch(String(expr), /::/, `Trino plan must not emit a Postgres cast: ${expr}`);
  assert.doesNotMatch(String(expr), /\bbtrim\(/, `Trino plan must not emit btrim(): ${expr}`);
}
// The rule the month key encodes survives the translation: a cancelled credit
// must not drag the credit line out of the month it was earned in.
assert.match(trinoPlan.businessAtExpr, /cancelled_at/);
assert.doesNotMatch(trinoPlan.occurredAtExpr, /cancelled_at/);

// ---- The generator's own call sites ----------------------------------------
// Pinned against the literal SQL the pre-Starburst code emitted, so the
// Supabase path cannot drift while the Trino path is being worked on.
assert.equal(
  monthBoundsCte("2026-09", TZ),
  `bounds as (
  select
    (timestamp '2026-09-01' at time zone 'America/Chicago') as month_start,
    ((timestamp '2026-09-01' at time zone 'America/Chicago') + interval '1 month') as month_end,
    ((timestamp '2026-09-01' at time zone 'America/Chicago') - interval '1 month') as scoring_start
)`
);
assert.equal(candidateDayExpr("l.created_at", "timestamp with time zone", TZ, pg),
  "(l.created_at at time zone 'America/Chicago')::date::text");
assert.equal(candidateDayExpr("c.business_date", "date", TZ, pg), "c.business_date::text");
assert.equal(candidateDayExpr("l.notes", "text", TZ, pg), "left((l.notes)::text, 10)");

const trinoBounds = monthBoundsCte("2026-09", TZ, trino);
assert.match(trinoBounds, /with_timezone\(timestamp '2026-09-01', 'America\/Chicago'\)/);
assert.match(trinoBounds, /\+ interval '1' MONTH/);
assert.doesNotMatch(trinoBounds, /::/);
assert.equal(
  candidateDayExpr("l.notes", "text", TZ, trino),
  "substr(cast(l.notes as varchar), 1, 10)"
);

// ---- Host normalization ----------------------------------------------------
assert.equal(starburstBaseUrl("example.trino.galaxy.starburst.io"), "https://example.trino.galaxy.starburst.io");
assert.equal(starburstBaseUrl("example.internal", "8443"), "https://example.internal:8443");
assert.equal(starburstBaseUrl("https://example.internal:8443/"), "https://example.internal:8443");
assert.equal(starburstBaseUrl("example.internal", "8080", "false"), "http://example.internal:8080");
assert.equal(starburstBaseUrl(""), "");

console.log("ok — Postgres SQL unchanged, Trino SQL avoids Postgres-only syntax, types normalize");
