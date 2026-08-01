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

// ---- Transfers to another rep -----------------------------------------------
// The same shape as above — this month's sale, cancelled this month — but the
// ledger handed the credit to a different rep in the same write. The sale was
// not lost, it moved, and the rep-scores export lists only the reps holding the
// attribution now: it drops both halves of the swap. Joined onto the July
// export by ledger id, 8 lines (-4.0) were this, and every one of them was
// otherwise indistinguishable from the 16 same-month cancels the export counts.
const transferredOut = netLedgerJournal(
  [
    line({ ledgerId: 674101, attributionId: 84101, members: 0.5, sessions: 4, date: "2026-07-02" }),
    {
      ...line({ ledgerId: 674102, attributionId: 84101, members: -0.5, sessions: -4, date: "2026-07-24" }),
      transferred_out: true,
    },
  ],
  DISPLAY,
  new Set(),
  MONTH
);
assert.equal(totals(transferredOut.rows).cancelMembers, 0, "a sale handed to another rep is not attrition");
assert.equal(totals(transferredOut.rows).members, 0, "and the pair still nets to zero — members do not move");
assert.equal(transferredOut.washed.length, 1, "the transfer is reported, not silently dropped");

// The flag alone is not enough: a transfer wash folds the cancel back into a
// credit, so with nothing in the window to fold into the line stays. That is
// what keeps the two same-rep period transfers in the July dump on the tile
// rather than quietly disappearing into a rule that cannot account for them.
const transferNoCredit = netLedgerJournal(
  [
    {
      ...line({ ledgerId: 674103, attributionId: 84102, members: -0.5, sessions: -4, date: "2026-07-24", lifetimeMembers: 0, lifetimeSessions: 0 }),
      transferred_out: true,
    },
  ],
  DISPLAY,
  new Set(),
  MONTH
);
assert.equal(totals(transferNoCredit.rows).cancelMembers, -0.5, "no in-window credit, nothing to wash into");
assert.equal(transferNoCredit.washed.length, 0);

// Membership fits, sessions don't: still wash. The first wash release required
// both dimensions and left 25 of 41 period-transfer lines on the tile because
// a 0.5/2 re-booking credit could not absorb a 0.5/8 cancel on the session side.
const mismatchWash = netLedgerJournal(
  [
    line({ ledgerId: 673501, attributionId: 83501, members: 0.5, sessions: 2, date: "2026-07-12", saleDate: "2026-06-20" }),
    line({ ledgerId: 673502, attributionId: 83501, members: -0.5, sessions: -8, date: "2026-07-12", saleDate: "2026-06-20" }),
  ],
  DISPLAY,
  new Set(),
  MONTH
);
assert.equal(totals(mismatchWash.rows).cancelMembers, 0, "member fit is enough to wash a transfer");
assert.equal(mismatchWash.washed.length, 1);

// Credit on one attribution, a prior-month cancel on another, same client and
// rep. v4 washed this pair, guessing the ~25 leftover July lines were
// re-bookings that had opened a new attribution. Joined onto the export by
// ledger id, none of those 25 has in-window credit at any grain — the rule
// matched nothing in production and the shape it was built for does not exist.
// A second sale to a client who also cancelled is the shape that *does* exist,
// and both halves of it are real.
const crossAttr = netLedgerJournal(
  [
    line({ ledgerId: 673601, attributionId: 83601, members: 1, sessions: 8, date: "2026-07-12", saleDate: "2026-07-12", clientId: "900001" }),
    line({ ledgerId: 673602, attributionId: 83602, members: -1, sessions: -8, date: "2026-07-12", saleDate: "2026-06-20", clientId: "900001", lifetimeMembers: 0, lifetimeSessions: 0 }),
  ],
  DISPLAY,
  new Set(),
  MONTH
);
assert.equal(totals(crossAttr.rows).cancelMembers, -1, "a cancel on another attribution is still a cancel");
assert.equal(totals(crossAttr.rows).members, 0, "the new sale and the old cancel net out, as the export has them");
assert.equal(crossAttr.washed.length, 0, "nothing is washed across attributions");

// Orphan whose lifetime overshoots members but not sessions — still drop.
// The SPIFF cancels (Amanda/Jordan against someone else's sale) were surviving
// the orphan rule because sessions did not fit the overshoot.
const orphanMismatch = netLedgerJournal(
  [line({ ledgerId: 673701, attributionId: 83701, members: -0.5, sessions: -8, lifetimeMembers: -0.5, lifetimeSessions: 0 })],
  DISPLAY,
  new Set(),
  MONTH
);
assert.equal(totals(orphanMismatch.rows).cancelMembers, 0, "orphan drop keys on members");
assert.equal(orphanMismatch.suppressed[0].reason, "orphan-cancel");

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

// Cancel line items carry the per-line facts a dump needs to be joined onto a
// rep-scores export, and adding them must not change what the tiles total.
{
  const diagRows = netLedgerJournal(
    [
      line({ ledgerId: 674001, attributionId: 84001, members: 1, sessions: 8, date: "2026-07-04", clientId: "910001" }),
      line({ ledgerId: 674002, attributionId: 84001, members: -1, sessions: -8, date: "2026-07-28", clientId: "910001", lifetimeMembers: 0, lifetimeSessions: 0 }),
    ],
    DISPLAY,
    new Set()
  ).rows;
  const diag = cancelLineItems(diagRows, DISPLAY);
  assert.equal(diag.length, 1, "one cancel line");
  assert.equal(diag[0].attributionId, "84001");
  assert.equal(diag[0].ledgerId, "674002");
  assert.equal(diag[0].lifetimeMembers, 0, "lifetime rides along for the dump");
  assert.equal(diag[0].attrWindowCredit, 1, "credit on this attribution inside the window");
  assert.equal(diag[0].clientRepWindowCredit, 1, "credit for this client+rep inside the window");
  assert.equal(
    diag.reduce((s, d) => s + d.members, 0),
    -1,
    "diagnostics do not change what the cancel lines total"
  );
}

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

// ---- Credit join wash (orphan / wrong-month) --------------------------------
// The July dump's 28 export leftovers are almost all unresolved credit_ids.
// When the live query sets credit_matched=false, those cancels must leave the
// tile. Undefined credit_matched (join unavailable) must leave them alone so a
// failed probe cannot zero attrition.
const orphanCredit = netLedgerJournal(
  [
    {
      ...line({
        ledgerId: 665038,
        attributionId: 76697,
        members: -1,
        sessions: -4,
        date: "2026-07-01",
        saleDate: "2026-06-01",
        lifetimeMembers: 0,
        lifetimeSessions: 0,
      }),
      credit_id: "8c7e9fa6-bd3b-4b24-bbbb-f7ad295ac4ba",
      credit_matched: false,
    },
    {
      ...line({
        ledgerId: 675212,
        attributionId: 83797,
        members: -1,
        sessions: -4,
        date: "2026-07-31",
        saleDate: "2026-07-09",
        lifetimeMembers: 0,
        lifetimeSessions: 0,
      }),
      credit_id: "10022870",
      credit_matched: true,
      credit_business_date: "2026-07-31",
    },
  ],
  DISPLAY,
  new Set(),
  "2026-07"
);
assert.equal(
  totals(orphanCredit.rows).cancelMembers,
  -1,
  "unresolved credit_id cancels are washed; resolved ones stay"
);
assert.equal(orphanCredit.washed.length, 1);
assert.equal(orphanCredit.washed[0].reason, "orphan-credit");
assert.equal(orphanCredit.washed[0].ledgerId, "665038");

// A cancel belongs to the month its credit occurred in — the export's
// attribution_date. A June credit reversed in July is June's line.
const wrongMonthCredit = netLedgerJournal(
  [
    {
      ...line({
        ledgerId: 669010,
        attributionId: 78780,
        members: -1,
        sessions: -4,
        date: "2026-07-12",
        saleDate: "2026-06-12",
        lifetimeMembers: 0,
        lifetimeSessions: 0,
      }),
      credit_id: "e868bfb8-f8cd-47c0-a271-1bceae96f5c4",
      credit_matched: true,
      credit_business_date: "2026-06-12",
    },
  ],
  DISPLAY,
  new Set(),
  "2026-07"
);
assert.equal(totals(wrongMonthCredit.rows).cancelMembers, 0, "a June credit's cancel is not July's");
assert.equal(wrongMonthCredit.washed[0]?.reason, "credit-month");
assert.equal(wrongMonthCredit.washed[0]?.creditMonth, "2026-06");

// It is dropped, not folded into a credit that does belong to this month:
// netting it there would move this month's members by another month's loss.
const creditMonthWithSale = netLedgerJournal(
  [
    line({
      ledgerId: 670000,
      attributionId: 78780,
      members: 1,
      sessions: 8,
      date: "2026-07-20",
      saleDate: "2026-07-20",
      lifetimeMembers: 0,
      lifetimeSessions: 0,
    }),
    {
      ...line({
        ledgerId: 670001,
        attributionId: 78780,
        members: -1,
        sessions: -4,
        date: "2026-07-21",
        saleDate: "2026-07-20",
        lifetimeMembers: 0,
        lifetimeSessions: 0,
      }),
      credit_matched: true,
      credit_business_date: "2026-06-12",
    },
  ],
  DISPLAY,
  new Set(),
  "2026-07"
);
assert.equal(totals(creditMonthWithSale.rows).members, 1, "this month's credit is left alone");
assert.equal(totals(creditMonthWithSale.rows).cancelMembers, 0);

// A cancel whose credit occurred this month stays, whatever day it was written.
const inMonthCredit = netLedgerJournal(
  [
    {
      ...line({
        ledgerId: 674865,
        attributionId: 82149,
        members: -1,
        sessions: -4,
        date: "2026-07-30",
        saleDate: "2026-06-30",
        lifetimeMembers: 0,
        lifetimeSessions: 0,
      }),
      credit_matched: true,
      credit_business_date: "2026-07-06",
    },
  ],
  DISPLAY,
  new Set(),
  "2026-07"
);
assert.equal(totals(inMonthCredit.rows).cancelMembers, -1, "July credit, July cancel");
assert.equal(inMonthCredit.washed.length, 0);

// The cancel list is dated the way the export dates it, with the ledger day
// still on the row for anyone reconciling the ledger itself.
const datedItems = cancelLineItems(inMonthCredit.rows, DISPLAY);
assert.equal(datedItems[0].date, "2026-07-06", "the list shows the export's attribution_date");
assert.equal(datedItems[0].ledgerDate, "2026-07-30", "and keeps the day the reversal was written");

const noCreditSignal = netLedgerJournal(
  [
    line({
      ledgerId: 665038,
      attributionId: 76697,
      members: -1,
      sessions: -4,
      date: "2026-07-01",
      saleDate: "2026-06-01",
      lifetimeMembers: 0,
      lifetimeSessions: 0,
    }),
  ],
  DISPLAY,
  new Set(),
  "2026-07"
);
assert.equal(
  totals(noCreditSignal.rows).cancelMembers,
  -1,
  "without credit_matched the orphan-credit wash must not fire"
);

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

console.log("ok — journal rows, cancel classification, month window, dedupe, line items, period duplicates, credit-join wash, etags");
