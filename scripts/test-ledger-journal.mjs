/**
 * Locks in how the live ledger is turned into MTD.
 * Run: npm test
 *
 * Shapes, ids and dates below are taken from the real July 2026 rep-scores
 * export, so a regression here means live pace has drifted from the source
 * ledger again. The functions under test are imported from the Netlify function
 * itself rather than re-implemented, so the test can't pass while the shipped
 * code does something else.
 */
import assert from "node:assert/strict";
import {
  netLedgerJournal,
  pickMonthKey,
  monthKeyDayExpr,
  monthKeyStampExpr,
  monthKeyWindowSql,
} from "../functions/get-live-actuals.mts";

const EMAIL = "becky.ruffer@varsitytutors.com";
const DISPLAY = { [EMAIL]: "Becky Ruffer" };

/** One ledger line, in the shape the live query returns. */
function line({ ledgerId, attributionId, members, sessions, date = "2026-07-31", clientId = "8568597" }) {
  return {
    email: EMAIL,
    manager_name: "Becky Ruffer",
    client_id: clientId,
    attribution_date: date,
    occurred_at: `${date} 12:00:00`,
    sale_occurred_at: `${date} 12:00:00`,
    members,
    sessions,
    ledger_id: String(ledgerId),
    attribution_id: String(attributionId),
    manager_id: "2210",
    // Journal order follows write order; ledger ids break same-day ties.
    ledger_created_at: `${date}T12:00:00Z`,
  };
}

const journal = (lines) => netLedgerJournal(lines, DISPLAY, new Set()).rows;

const totals = (rows) => ({
  members: rows.reduce((s, r) => s + r.members, 0),
  sessions: rows.reduce((s, r) => s + r.sessions, 0),
  cancelMembers: rows.filter((r) => r.kind === "cancel").reduce((s, r) => s + r.members, 0),
  cancelSessions: rows.filter((r) => r.kind === "cancel").reduce((s, r) => s + r.sessions, 0),
});

// attr 87409 (Becky, client 8568597): booked at 100%, reversed, rebooked at 50%.
// The export carries ONE Becky line for this client at 0.5/4 — the pacer must
// not list the 100% and the 50% side by side.
const doubleAttro = journal([
  line({ ledgerId: 675266, attributionId: 87409, members: 1, sessions: 8 }),
  line({ ledgerId: 675272, attributionId: 87409, members: -1, sessions: -8 }),
  line({ ledgerId: 675273, attributionId: 87409, members: 0.5, sessions: 4 }),
]);
assert.equal(doubleAttro.length, 1, "a corrected attribution is one row, not three");
assert.equal(doubleAttro[0].members, 0.5);
assert.equal(doubleAttro[0].sessions, 4);
assert.equal(doubleAttro[0].ledger_id, "675273", "sale key follows the surviving revision");
assert.equal(totals(doubleAttro).cancelSessions, 0, "a rebooked correction is not attrition");

// attr 85853 (Becky, client 8567062): sale then full cancellation.
const fullCancel = journal([
  line({ ledgerId: 672265, attributionId: 85853, members: 1, sessions: 8, date: "2026-07-22" }),
  line({ ledgerId: 672910, attributionId: 85853, members: -1, sessions: -8, date: "2026-07-23" }),
]);
assert.equal(fullCancel.length, 2, "the cancel keeps its own row and its own date");
assert.deepEqual(fullCancel.map((r) => r.kind), ["credit", "cancel"]);
assert.equal(totals(fullCancel).sessions, 0, "sale plus cancel nets to zero");
assert.equal(totals(fullCancel).cancelSessions, -8, "and still reports as attrition");

// attr 86028 (Del, client 8567241): two credits, one pulled back.
const twoCredits = journal([
  line({ ledgerId: 672612, attributionId: 86028, members: 1, sessions: 8 }),
  line({ ledgerId: 672613, attributionId: 86028, members: 0, sessions: 8 }),
  line({ ledgerId: 673182, attributionId: 86028, members: -1, sessions: -8 }),
]);
assert.equal(totals(twoCredits).members, 0);
assert.equal(totals(twoCredits).sessions, 8);

// attr 82765 (Chris, client 8561761): 8 sessions booked, 6 pulled back.
const partial = journal([
  line({ ledgerId: 665965, attributionId: 82765, members: 1, sessions: 8 }),
  line({ ledgerId: 673113, attributionId: 82765, members: -1, sessions: -6 }),
]);
assert.equal(totals(partial).sessions, 2);

// attr 77803 (Becky, client 8556569): a June sale cancelled on 7/2 reaches the
// July ledger as a single negative line, with no credit line beside it.
const priorSaleCancel = journal([
  line({ ledgerId: 666899, attributionId: 77803, members: -1, sessions: -8, date: "2026-07-02" }),
]);
assert.equal(totals(priorSaleCancel).cancelSessions, -8);

// ---- Month key -------------------------------------------------------------
// A ledger line belongs to the month its own business date falls in — the
// export's `attribution_date`. The two other columns we tried are both wrong
// against the July export's -50.5 members / -336 sessions of cancels:
//
//   attributions.occurred_at  -> -14.0 / -108  (only cancels of July sales;
//                                 occurred_at stays on the sale's date)
//   rep_scores...created_at   -> -86.5         (also charges July for
//                                 June-dated lines that were written in July)
const LEDGER_COLUMNS = [
  { column_name: "created_at", data_type: "timestamp with time zone" },
  { column_name: "updated_at", data_type: "timestamp with time zone" },
  { column_name: "attribution_date", data_type: "timestamp with time zone" },
];
assert.deepEqual(pickMonthKey(LEDGER_COLUMNS), {
  column: "attribution_date",
  dataType: "timestamp with time zone",
  discovered: true,
});

// created_at is never picked as the business date — it is only the fallback the
// handler uses when no candidate column exists at all.
assert.equal(pickMonthKey([{ column_name: "created_at", data_type: "timestamp with time zone" }]), null);
assert.equal(pickMonthKey([]), null);

// Whatever the column's type, the month key reads as a Chicago calendar day, so
// a line written at 8pm Central on the 31st can't land in next month.
assert.equal(
  monthKeyDayExpr({ column: "attribution_date", dataType: "timestamp with time zone" }, "America/Chicago"),
  "(l.attribution_date at time zone 'America/Chicago')::date"
);
assert.equal(
  monthKeyDayExpr({ column: "attribution_date", dataType: "timestamp without time zone" }, "America/Chicago"),
  "((l.attribution_date at time zone 'UTC') at time zone 'America/Chicago')::date"
);
assert.equal(
  monthKeyDayExpr({ column: "effective_date", dataType: "date" }, "America/Chicago"),
  "l.effective_date"
);
assert.equal(
  monthKeyStampExpr({ column: "effective_date", dataType: "date" }, "America/Chicago"),
  "l.effective_date::text"
);

// The window compares the column itself against pre-computed bounds, so the
// ledger's index on that column still applies — a cast on the left of the
// comparison would make every poll a full scan.
for (const [dataType, column] of [
  ["timestamp with time zone", "attribution_date"],
  ["timestamp without time zone", "entry_date"],
  ["date", "effective_date"],
]) {
  const window = monthKeyWindowSql({ column, dataType });
  assert.ok(window.startsWith(`l.${column} >= `), `${dataType}: bare column on the left`);
  assert.ok(window.includes(`and l.${column} <  `), `${dataType}: half-open upper bound`);
}

console.log("ok — journal rows, cancel classification, month key, month window");
