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
  lineInLiveMonth,
  cancelLineItems,
  livePayloadEtag,
} from "../functions/get-live-actuals.mts";

const EMAIL = "becky.ruffer@varsitytutors.com";
const DISPLAY = { [EMAIL]: "Becky Ruffer" };

/** One ledger line, in the shape the live query returns. */
function line({
  ledgerId,
  attributionId,
  members,
  sessions,
  date = "2026-07-31",
  clientId = "8568597",
  lifetimeMembers,
  lifetimeSessions,
  saleDate = date,
}) {
  return {
    email: EMAIL,
    manager_name: "Becky Ruffer",
    client_id: clientId,
    attribution_date: date,
    occurred_at: `${date} 12:00:00`,
    sale_occurred_at: `${saleDate} 12:00:00`,
    members,
    sessions,
    ledger_id: String(ledgerId),
    attribution_id: String(attributionId),
    manager_id: "2210",
    // Journal order follows write order; ledger ids break same-day ties.
    ledger_created_at: `${date}T12:00:00Z`,
    ...(lifetimeMembers === undefined ? {} : { lifetime_members: lifetimeMembers }),
    ...(lifetimeSessions === undefined ? {} : { lifetime_sessions: lifetimeSessions }),
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

// ---- Month window ----------------------------------------------------------
// Line date = ledger created_at month. Sale date = attributions.occurred_at
// month. Both conditions required — either alone reproduces a wrong total we
// already shipped (-14 without prior-month sales, -86.5 without the sale gate).
const MONTH = "2026-07";
const PRIOR = "2026-06";
const inMonth = (lineMonth, saleMonth) =>
  lineInLiveMonth({ lineMonth, saleMonth }, MONTH, PRIOR);

assert.equal(inMonth("2026-07", "2026-07"), true, "July sale credited in July");
assert.equal(inMonth("2026-07", "2026-06"), true, "June sale cancelled in July");
assert.equal(inMonth("2026-06", "2026-06"), false, "June-dated line stays in June");
assert.equal(inMonth("2026-07", "2026-05"), false, "May sale cancel no longer scores");
assert.equal(inMonth("2026-07", "2026-04"), false, "older cancels stay out");

// ---- Duplicate ledger rows -------------------------------------------------
// A rep with two live flex_team_members records fans the join out and the same
// ledger line arrives twice. Counting it twice is how a -50.5 export becomes an
// -86.5 tile, so identical ledger ids collapse to one row.
const fannedOut = netLedgerJournal(
  [
    line({ ledgerId: 666899, attributionId: 77803, members: -1, sessions: -8, date: "2026-07-02" }),
    line({ ledgerId: 666899, attributionId: 77803, members: -1, sessions: -8, date: "2026-07-02" }),
  ],
  DISPLAY,
  new Set()
);
assert.equal(fannedOut.duplicateRows, 1, "the repeated ledger id is dropped");
assert.equal(totals(fannedOut.rows).cancelMembers, -1, "and counted once");

// ---- Cancel line items -----------------------------------------------------
// The tiles are totalled from these rows in the browser, so every number on a
// cancel tile can be traced to a line a human can read.
const items = cancelLineItems(fullCancel, DISPLAY);
assert.equal(items.length, 1, "only the cancel is itemised, not the sale");
assert.equal(items[0].rep, "Becky Ruffer");
assert.equal(items[0].clientId, "8568597");
assert.equal(items[0].members, -1);
assert.equal(items[0].sessions, -8);
assert.equal(
  items.reduce((s, r) => s + r.members, 0),
  totals(fullCancel).cancelMembers,
  "itemised total equals the tile total"
);

// ---- Period-transfer duplicates --------------------------------------------
// Cancelling a prior-month sale writes two lines: one unwinding the credit in
// the month it was booked, one charging the month the cancel landed in. A window
// on write time sees both and charges the rep twice — that is the -86.5 the
// tiles showed against the export's -50.5.
//
// The tell is arithmetic: over all time an attribution cannot lose more than it
// was credited (0 of 5,956 complete journals in the July export net below zero).
const periodDuplicate = netLedgerJournal(
  [
    // Sale was +1/8 last month, so the credit is outside this window and the
    // journal's all-time net is 1 - 1 - 1 = -1: one line too many.
    line({ ledgerId: 666899, attributionId: 77803, members: -1, sessions: -8, date: "2026-07-02", lifetimeMembers: -1, lifetimeSessions: -8 }),
    line({ ledgerId: 666900, attributionId: 77803, members: -1, sessions: -8, date: "2026-07-02", lifetimeMembers: -1, lifetimeSessions: -8 }),
  ],
  DISPLAY,
  new Set()
);
assert.equal(totals(periodDuplicate.rows).cancelMembers, -1, "a cancelled sale is charged once");
assert.equal(totals(periodDuplicate.rows).cancelSessions, -8);
assert.equal(periodDuplicate.suppressed.length, 1, "and the duplicate is reported, not silently dropped");
assert.equal(periodDuplicate.suppressed[0].reason, "duplicate-period-line");

// The safety case that matters most: a genuine cancel of a prior-month sale has
// its credit outside the window too, but the journal nets to zero over all time,
// so nothing may be dropped.
const genuinePriorCancel = netLedgerJournal(
  [line({ ledgerId: 666899, attributionId: 77803, members: -1, sessions: -8, date: "2026-07-02", lifetimeMembers: 0, lifetimeSessions: 0 })],
  DISPLAY,
  new Set()
);
assert.equal(totals(genuinePriorCancel.rows).cancelMembers, -1, "a real prior-month cancel still counts");
assert.equal(genuinePriorCancel.suppressed.length, 0);

// An orphan cancel — negative lifetime, no credit for this manager anywhere —
// is bookkeeping. The July dump's Amanda/Jordan SPIFF cancels against sales
// credited to other reps were this shape (~-5.5 of the -90.5 tile).
const orphanCancel = netLedgerJournal(
  [line({ ledgerId: 670001, attributionId: 80001, members: -0.5, sessions: -4, lifetimeMembers: -0.5, lifetimeSessions: -4 })],
  DISPLAY,
  new Set()
);
assert.equal(totals(orphanCancel.rows).cancelMembers, 0, "an orphan cancel is dropped");
assert.equal(orphanCancel.suppressed.length, 1);
assert.equal(orphanCancel.suppressed[0].reason, "orphan-cancel");

// ---- Period-transfer wash ---------------------------------------------------
// Cancelling a prior month's sale can re-book the credit into this month and
// cancel it in the same breath. Both lines land in this window on a journal
// whose sale is older than the window; the export shows neither, because they
// belong to the month the sale lived in. 41 lines / -34.5 members of the July
// dump were this shape.
const transferWash = netLedgerJournal(
  [
    line({ ledgerId: 673101, attributionId: 83101, members: 1, sessions: 8, date: "2026-07-12", saleDate: "2026-06-20" }),
    line({ ledgerId: 673102, attributionId: 83101, members: -1, sessions: -8, date: "2026-07-12", saleDate: "2026-06-20" }),
  ],
  DISPLAY,
  new Set(),
  MONTH
);
assert.equal(totals(transferWash.rows).cancelMembers, 0, "a re-booked prior-month sale is not attrition");
assert.equal(totals(transferWash.rows).members, 0, "and the pair still nets to zero — members do not move");
assert.equal(transferWash.washed.length, 1, "the washed line is reported, not silently dropped");
assert.equal(transferWash.washed[0].saleMonth, "2026-06");

// The same shape with no credit in the window is a genuine prior-month cancel:
// the sale's credit sits in the month it was booked. 44 July lines were this,
// and the export counts every one.
const genuinePriorMonth = netLedgerJournal(
  [line({ ledgerId: 673201, attributionId: 83201, members: -1, sessions: -8, date: "2026-07-12", saleDate: "2026-06-20", lifetimeMembers: 0, lifetimeSessions: 0 })],
  DISPLAY,
  new Set(),
  MONTH
);
assert.equal(totals(genuinePriorMonth.rows).cancelMembers, -1, "a prior-month cancel with no offsetting credit still counts");
assert.equal(genuinePriorMonth.washed.length, 0);

// A sale made and cancelled inside the same month is real attrition, even
// though its journal also nets to zero. Keying the wash on the sale month is
// what tells the two apart.
const sameMonthCancel = netLedgerJournal(
  [
    line({ ledgerId: 673301, attributionId: 83301, members: 1, sessions: 4, date: "2026-07-09" }),
    line({ ledgerId: 673302, attributionId: 83301, members: -1, sessions: -4, date: "2026-07-31" }),
  ],
  DISPLAY,
  new Set(),
  MONTH
);
assert.equal(totals(sameMonthCancel.rows).cancelMembers, -1, "this month's sale cancelled this month is attrition");
assert.equal(sameMonthCancel.washed.length, 0);

// Without a window month the journal behaves exactly as it did before.
const noWindow = netLedgerJournal(
  [
    line({ ledgerId: 673401, attributionId: 83401, members: 1, sessions: 8, date: "2026-07-12", saleDate: "2026-06-20" }),
    line({ ledgerId: 673402, attributionId: 83401, members: -1, sessions: -8, date: "2026-07-12", saleDate: "2026-06-20" }),
  ],
  DISPLAY,
  new Set()
);
assert.equal(totals(noWindow.rows).cancelMembers, -1, "the wash is opt-in");

// Drop no more than the overshoot: two cancels, only one line too many.
const partialOvershoot = netLedgerJournal(
  [
    line({ ledgerId: 671001, attributionId: 81001, members: -1, sessions: -4, lifetimeMembers: -1, lifetimeSessions: -4 }),
    line({ ledgerId: 671002, attributionId: 81001, members: -1, sessions: -4, lifetimeMembers: -1, lifetimeSessions: -4 }),
    line({ ledgerId: 671003, attributionId: 81001, members: -1, sessions: -4, lifetimeMembers: -1, lifetimeSessions: -4 }),
  ],
  DISPLAY,
  new Set()
);
assert.equal(totals(partialOvershoot.rows).cancelMembers, -2, "only the overshoot is removed");

// Without lifetime totals (an older cached payload) nothing is dropped.
const noLifetime = netLedgerJournal(
  [
    line({ ledgerId: 672001, attributionId: 82001, members: -1, sessions: -8 }),
    line({ ledgerId: 672002, attributionId: 82001, members: -1, sessions: -8 }),
  ],
  DISPLAY,
  new Set()
);
assert.equal(totals(noLifetime.rows).cancelMembers, -2, "no lifetime totals means no guessing");

// ---- Poll ETags ------------------------------------------------------------
// A compact poll and a full one carry the same totals but different bodies. If
// they shared a tag, a tab that had polled compact and then needed line items
// would get a 304 and render an empty Cancels list.
const samePayload = {
  actuals: { asOf: "2026-07-31", perRep: { "Becky Ruffer": { members: 1, sessions: 8, membersCancels: 0, sessionsCancels: 0 } } },
  cancelItems: [],
};
assert.notEqual(
  livePayloadEtag(samePayload, true),
  livePayloadEtag(samePayload, false),
  "compact and full payloads must not share an ETag"
);
assert.equal(livePayloadEtag(samePayload, true), livePayloadEtag({ ...samePayload }, true), "same shape, same tag");
const movedCancels = {
  ...samePayload,
  actuals: { asOf: "2026-07-31", perRep: { "Becky Ruffer": { members: 1, sessions: 8, membersCancels: -1, sessionsCancels: -8 } } },
};
assert.notEqual(
  livePayloadEtag(samePayload, true),
  livePayloadEtag(movedCancels, true),
  "a cancel moving must break the tag, or tiles freeze on a stale number"
);

console.log("ok — journal rows, cancel classification, month window, dedupe, line items, period duplicates, etags");
