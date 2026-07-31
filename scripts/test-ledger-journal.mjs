/**
 * Locks in how the live ledger is turned into MTD.
 * Run: node scripts/test-ledger-journal.mjs
 *
 * Shapes and ids below are taken from the real July 2026 rep-scores export, so
 * a regression here means live pace has drifted from the source ledger again.
 */
import assert from "node:assert/strict";

/**
 * Mirrors netLedgerJournal: classify one attribution's lines, fold credits and
 * their revisions into a single row, keep cancels as their own rows.
 */
function journalRows(lines) {
  const ordered = [...lines].sort((a, b) => a.ledgerId - b.ledgerId);
  const classified = ordered.map((line, index) => {
    const negative = line.members < 0 || line.sessions < 0;
    if (!negative) return { ...line, kind: "credit" };
    const replacedLater = ordered
      .slice(index + 1)
      .some((later) => later.members > 0 || later.sessions > 0);
    return { ...line, kind: replacedLater ? "reversal" : "cancel" };
  });

  const creditLines = classified.filter((l) => l.kind !== "cancel");
  const cancelLines = classified.filter((l) => l.kind === "cancel");
  const out = [];
  if (creditLines.length) {
    const members = creditLines.reduce((sum, l) => sum + l.members, 0);
    const sessions = creditLines.reduce((sum, l) => sum + l.sessions, 0);
    if (members !== 0 || sessions !== 0) {
      out.push({
        ...creditLines[0],
        members,
        sessions,
        ledgerId: creditLines[creditLines.length - 1].ledgerId,
        kind: "credit",
      });
    }
  }
  out.push(...cancelLines);
  return out;
}

const totals = (rows) => ({
  members: rows.reduce((s, r) => s + r.members, 0),
  sessions: rows.reduce((s, r) => s + r.sessions, 0),
  cancelMembers: rows.filter((r) => r.kind === "cancel").reduce((s, r) => s + r.members, 0),
  cancelSessions: rows.filter((r) => r.kind === "cancel").reduce((s, r) => s + r.sessions, 0),
});

// attr 87409 (Becky, client 8568597): booked at 100%, reversed, rebooked at 50%.
// The export carries ONE Becky line for this client at 0.5/4 — the pacer must
// not list the 100% and the 50% side by side.
const doubleAttro = journalRows([
  { ledgerId: 675266, members: 1, sessions: 8 },
  { ledgerId: 675272, members: -1, sessions: -8 },
  { ledgerId: 675273, members: 0.5, sessions: 4 },
]);
assert.equal(doubleAttro.length, 1, "a corrected attribution is one row, not three");
assert.equal(doubleAttro[0].members, 0.5);
assert.equal(doubleAttro[0].sessions, 4);
assert.equal(doubleAttro[0].ledgerId, 675273, "sale key follows the surviving revision");
assert.equal(totals(doubleAttro).cancelSessions, 0, "a rebooked correction is not attrition");

// attr 85853 (Becky, client 8567062): sale then full cancellation.
const fullCancel = journalRows([
  { ledgerId: 672265, members: 1, sessions: 8 },
  { ledgerId: 672910, members: -1, sessions: -8 },
]);
assert.equal(fullCancel.length, 2, "the cancel keeps its own row and its own date");
assert.deepEqual(fullCancel.map((r) => r.kind), ["credit", "cancel"]);
assert.equal(totals(fullCancel).sessions, 0, "sale plus cancel nets to zero");
assert.equal(totals(fullCancel).cancelSessions, -8, "and still reports as attrition");

// attr 86028 (Del, client 8567241): two credits, one pulled back.
const twoCredits = journalRows([
  { ledgerId: 672612, members: 1, sessions: 8 },
  { ledgerId: 672613, members: 0, sessions: 8 },
  { ledgerId: 673182, members: -1, sessions: -8 },
]);
assert.equal(totals(twoCredits).members, 0);
assert.equal(totals(twoCredits).sessions, 8);

// attr 82765 (Chris, client 8561761): 8 sessions booked, 6 pulled back.
const partial = journalRows([
  { ledgerId: 665965, members: 1, sessions: 8 },
  { ledgerId: 673113, members: -1, sessions: -6 },
]);
assert.equal(totals(partial).sessions, 2);

// A cancel of an earlier-month sale arrives as a single negative line.
const priorSaleCancel = journalRows([{ ledgerId: 666899, members: -1, sessions: -8 }]);
assert.equal(totals(priorSaleCancel).cancelSessions, -8);

// ---- Month window ----------------------------------------------------------
// A line belongs to the month when its own ledger date falls in the month AND
// the sale is still in scoring range (this month or the one before). Both
// conditions are required: the export's cancels all belong to June or July
// sales, and either condition alone reproduces one of the wrong totals we saw
// (-14.5/-108 with the sale date as the key, -86.5/-542 with no scoring gate).
function inMonth({ lineDate, saleDate }, month = "2026-07", prevMonth = "2026-06") {
  const monthOf = (d) => d.slice(0, 7);
  if (monthOf(lineDate) !== month) return false;
  return monthOf(saleDate) === month || monthOf(saleDate) === prevMonth;
}

// July sale credited in July.
assert.equal(inMonth({ lineDate: "2026-07-01", saleDate: "2026-07-01" }), true);
// ledger 672910 — July sale, cancel line dated later in July.
assert.equal(inMonth({ lineDate: "2026-07-23", saleDate: "2026-07-21" }), true);
// ledger 666899 — June sale, cancel line dated 07-02. Must count in July.
assert.equal(inMonth({ lineDate: "2026-07-02", saleDate: "2026-06-18" }), true);
// client 8555523 — line written in July but business-dated 6/30. Stays in June.
assert.equal(inMonth({ lineDate: "2026-06-30", saleDate: "2026-06-30" }), false);
// Cancel of a sale older than the prior month is no longer charged to the rep.
assert.equal(inMonth({ lineDate: "2026-07-15", saleDate: "2026-05-20" }), false);
// A June sale credited in July is in range.
assert.equal(inMonth({ lineDate: "2026-07-03", saleDate: "2026-06-30" }), true);

console.log("ok — journal rows, cancel classification, month window");
