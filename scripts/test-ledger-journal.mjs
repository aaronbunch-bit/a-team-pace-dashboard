/**
 * Locks in how the live ledger is totalled.
 * Run: node scripts/test-ledger-journal.mjs
 *
 * Shapes below are taken from the real July 2026 export, so a regression here
 * means live pace has drifted from the source ledger again.
 */
import assert from "node:assert/strict";

/** Classify + sum one attribution's journal, mirroring netLedgerJournal. */
function netJournal(lines) {
  const ordered = [...lines].sort((a, b) => a.ledgerId - b.ledgerId);
  const classified = ordered.map((line, index) => {
    const negative = line.members < 0 || line.sessions < 0;
    if (!negative) return { ...line, kind: "credit" };
    const replacedLater = ordered
      .slice(index + 1)
      .some((later) => later.members > 0 || later.sessions > 0);
    return { ...line, kind: replacedLater ? "reversal" : "cancel" };
  });
  return {
    lines: classified,
    netMembers: classified.reduce((sum, l) => sum + l.members, 0),
    netSessions: classified.reduce((sum, l) => sum + l.sessions, 0),
    // Reversals are bookkeeping, so they must not report as attrition.
    cancelMembers: classified
      .filter((l) => l.kind === "cancel")
      .reduce((sum, l) => sum + Math.min(l.members, 0), 0),
    cancelSessions: classified
      .filter((l) => l.kind === "cancel")
      .reduce((sum, l) => sum + Math.min(l.sessions, 0), 0),
  };
}

// attr 82399 (Becky, client 8561412): 100% booked, reversed, rebooked at 50%.
const correction = netJournal([
  { ledgerId: 665258, members: 1, sessions: 4 },
  { ledgerId: 665262, members: -1, sessions: -4 },
  { ledgerId: 665263, members: 0.5, sessions: 2 },
]);
assert.equal(correction.netMembers, 0.5);
assert.equal(correction.netSessions, 2);
assert.deepEqual(correction.lines.map((l) => l.kind), ["credit", "reversal", "credit"]);
assert.equal(correction.cancelMembers, 0, "a rebooked correction is not attrition");
assert.equal(correction.cancelSessions, 0);

// attr 85853 (Becky, client 8567062): sale then full cancellation.
// Newest-wins returned -1/-8 here, which is what pushed pace down.
const fullCancel = netJournal([
  { ledgerId: 672265, members: 1, sessions: 8 },
  { ledgerId: 672910, members: -1, sessions: -8 },
]);
assert.equal(fullCancel.netMembers, 0);
assert.equal(fullCancel.netSessions, 0);
assert.deepEqual(fullCancel.lines.map((l) => l.kind), ["credit", "cancel"]);
assert.equal(fullCancel.cancelSessions, -8, "the cancellation still reports as attrition");

// attr 86028 (Del, client 8567241): two credits, one pulled back.
const twoCreditsOnePulled = netJournal([
  { ledgerId: 672612, members: 1, sessions: 8 },
  { ledgerId: 672613, members: 0, sessions: 8 },
  { ledgerId: 673182, members: -1, sessions: -8 },
]);
assert.equal(twoCreditsOnePulled.netMembers, 0);
assert.equal(twoCreditsOnePulled.netSessions, 8);

// attr 82765 (Chris, client 8561761): 8 sessions booked, 6 pulled back.
const partial = netJournal([
  { ledgerId: 665965, members: 1, sessions: 8 },
  { ledgerId: 673113, members: -1, sessions: -6 },
]);
assert.equal(partial.netSessions, 2);

// A cancel of an earlier-month sale arrives as a single negative line.
const priorSaleCancel = netJournal([{ ledgerId: 666899, members: -1, sessions: -8 }]);
assert.equal(priorSaleCancel.netSessions, -8);
assert.deepEqual(priorSaleCancel.lines.map((l) => l.kind), ["cancel"]);

// ---- Month key -------------------------------------------------------------
// Business date is attributions.occurred_at (CSV attribution_date). Upstream
// updates it to the cancel date when a sale is cancelled, so prior-sale
// cancels that hit in July land in July. Ledger created_at is when the row
// was written — using it as the month key pulled cancels whose business date
// is still prior-month (client 8555523 on 6/30) and inflated cancel tiles
// from ~51.5/326 to ~86.5/542.
function monthKey(line) {
  return line.occurredAt.slice(0, 7);
}
assert.equal(
  monthKey({ occurredAt: "2026-07-23", ledgerCreatedAt: "2026-07-24" }),
  "2026-07",
  "cancel whose occurred_at was updated to the cancel date"
);
assert.equal(
  monthKey({ occurredAt: "2026-06-30", ledgerCreatedAt: "2026-07-15" }),
  "2026-06",
  "row written in July but business-dated 6/30 stays out of July (8555523)"
);
assert.equal(
  monthKey({ occurredAt: "2026-07-01", ledgerCreatedAt: "2026-07-01" }),
  "2026-07",
  "ordinary July sale"
);

console.log("ok — ledger journal netting + month key");
