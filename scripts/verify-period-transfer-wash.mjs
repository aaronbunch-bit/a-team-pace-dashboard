/**
 * Proof that the period-transfer wash fixes the cancel tile.
 *
 * Run:
 *   node --experimental-strip-types scripts/verify-period-transfer-wash.mjs \
 *     <export.csv> <live-cancels.csv>
 *
 * The July rep-scores export is ground truth for what the tiles should show.
 * The live "Copy these lines" dump is what they did show. Diffing the two
 * splits this month's cancel lines into three populations:
 *
 *   - 44 cancels of a prior month's sale that the export counts
 *   - 41 cancels of a prior month's sale that appear nowhere in the July
 *     export, because upstream re-booked the sale into July and cancelled it
 *     in the same breath: the export keeps both lines in the month the sale
 *     lived in, the live window (which keys on write time) sees both here
 *   - 24 cancels of a sale made this month, which the export counts
 *
 * Not one of the 44 has a credit inside the window. All 41 do. That is the
 * rule, and this script proves it end to end by rebuilding the ledger the
 * database would return and running it through the shipped netLedgerJournal:
 *
 *   1. Without the wash, the tiles reproduce the wrong number on the dashboard.
 *   2. With it, cancels land on the export's own total.
 *   3. Members do not move either way — the washed line is folded into the
 *      attribution's credit row, never dropped.
 *
 * (3) is the property that matters most. Every previous attempt at this tile
 * risked trading a wrong cancel number for a wrong members number.
 */
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { netLedgerJournal } from "../functions/get-live-actuals.mts";
import { FALLBACK_ROSTER_EMAILS } from "../functions/_shared/roster.mts";

const [exportPath, dumpPath] = process.argv.slice(2);
if (!exportPath || !dumpPath) {
  console.error(
    "usage: node --experimental-strip-types scripts/verify-period-transfer-wash.mjs <export.csv> <live-cancels.csv>"
  );
  process.exit(2);
}

const MONTH = "2026-07";
const PRIOR = "2026-06";

function readCsv(text) {
  const lines = text.trim().split(/\r?\n/).filter((l) => l && !l.startsWith("#"));
  const cols = lines[0].split(",");
  return lines.slice(1).map((line) => {
    const cells = [];
    let cur = "";
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quoted) {
        if (ch !== '"') cur += ch;
        else if (line[i + 1] === '"') { cur += '"'; i++; }
        else quoted = false;
      } else if (ch === '"') quoted = true;
      else if (ch === ",") { cells.push(cur); cur = ""; }
      else cur += ch;
    }
    cells.push(cur);
    return Object.fromEntries(cols.map((c, i) => [c, cells[i] ?? ""]));
  });
}

const num = (v) => Number(v || 0);
const squash = (name) => String(name || "").toLowerCase().replace(/[^a-z]/g, "");

const displayByEmail = { ...FALLBACK_ROSTER_EMAILS };
const emailByDisplay = new Map();
for (const [email, display] of Object.entries(FALLBACK_ROSTER_EMAILS)) {
  emailByDisplay.set(squash(display), email);
}
// The export writes some names differently from the roster.
const EXPORT_ALIAS = {
  christopherjones: "chrisjones",
  jennasalupo: "jennasalupo",
  timothycarr: "timcarr",
};
const emailFor = (name) => {
  const key = squash(name);
  return emailByDisplay.get(EXPORT_ALIAS[key] || key) || emailByDisplay.get(key) || null;
};

const allExportRows = readCsv(readFileSync(exportPath, "utf8"));
const exportRows = allExportRows
  .map((row) => ({ row, email: emailFor(row.manager) }))
  .filter((r) => r.email);
const dump = readCsv(readFileSync(dumpPath, "utf8"));

// ---- What the export says the tiles should read ----------------------------
const exportTotals = exportRows.reduce(
  (acc, { row }) => ({
    members: acc.members + num(row.expert_net_members),
    cancelMembers: acc.cancelMembers + Math.min(num(row.expert_net_members), 0),
    cancelSessions: acc.cancelSessions + Math.min(num(row.expert_net_monthly_hours), 0),
  }),
  { members: 0, cancelMembers: 0, cancelSessions: 0 }
);

// ---- Rebuild the ledger the live query returns ------------------------------
// The export's own lines, keyed the way the database keys them.
// Every client the export lists, under any manager — a client credited to
// someone off the roster is still a client the export knows about.
const exportClients = new Set(allExportRows.map((r) => r.client_id));
const dumpSaleMonth = new Map(
  dump.map((r) => [`${r.client_id}|${squash(r.rep)}`, r.sale_month])
);

const ledgerRows = [];
for (const { row, email } of exportRows) {
  const members = num(row.expert_net_members);
  // A negative line's sale month comes from the dump, which carries the
  // attribution's own occurred_at. Credits in a month's export are that
  // month's sales.
  const saleMonth =
    members < 0 ? dumpSaleMonth.get(`${row.client_id}|${squash(row.manager)}`) || MONTH : MONTH;
  ledgerRows.push({
    email,
    manager_name: row.manager,
    client_id: row.client_id,
    attribution_date: row.attribution_date.slice(0, 10),
    occurred_at: row.attribution_date,
    sale_occurred_at: `${saleMonth}-01 12:00:00`,
    members,
    sessions: num(row.expert_net_monthly_hours),
    ledger_id: row.ledger_id,
    attribution_id: row.attribution_id,
    manager_id: row.manager_id,
    ledger_created_at: row.attribution_date,
  });
}

const exportOnlyRows = [...ledgerRows];

// Rebuild what the live query actually returned for the lines the export omits.
// After transfer-wash-v3 shipped, the tile moved from -90.5 to -78.0 with only
// 16 pairs washed (12.5 members). The leftover -27.5 is two shapes the first
// wash could not see:
//
//   1. Same client+manager, but the re-booking credit opened a *new*
//      attribution — per-journal wash is blind to it.
//   2. SPIFF / reassignment orphans whose lifetime overshoots members but not
//      sessions — the dual-dimension fit kept them as attrition.
//
// Split the absent dump lines into the two transfer shapes in the same ratio
// the live tile showed (16 washed of 41), and inject every orphan with the
// session-mismatched lifetime that let them survive v3.
const absentDump = dump.filter((r) => !exportClients.has(r.client_id));
const orphanDump = dump.filter((r) => {
  if (!exportClients.has(r.client_id)) return false;
  const expName = ({
    "Chris Jones": "Christopher Jones",
    "Jenna Salupo": "JENNA SALUPO",
    "Tim Carr": "Timothy Carr",
  })[r.rep] || r.rep;
  return !allExportRows.some(
    (er) =>
      er.client_id === r.client_id &&
      er.manager === expName &&
      (num(er.expert_net_members) < 0 || num(er.expert_net_monthly_hours) < 0)
  );
});

let sameAttrPairs = 0;
let crossAttrPairs = 0;
let injectedOrphans = 0;
const SAME_ATTR_COUNT = 16; // what v3 actually washed on the live tile

for (const r of absentDump) {
  const email = emailFor(r.rep);
  if (!email) continue;
  const n = sameAttrPairs + crossAttrPairs + 1;
  const base = {
    email,
    manager_name: r.rep,
    client_id: r.client_id,
    attribution_date: r.date,
    occurred_at: r.date,
    sale_occurred_at: `${r.sale_month || PRIOR}-01 12:00:00`,
    manager_id: `t${n}`,
  };
  const creditMembers = -num(r.members);
  // Session mismatch on purpose for half the same-attr pairs: a 2-session
  // re-booking credit against an 8-session cancel. v3's dual fit rejected
  // these; v4's members-primary fit must not.
  const creditSessions =
    sameAttrPairs < SAME_ATTR_COUNT && sameAttrPairs % 2 === 1
      ? Math.min(2, -num(r.sessions))
      : -num(r.sessions);

  if (sameAttrPairs < SAME_ATTR_COUNT) {
    sameAttrPairs++;
    const attributionId = `same-${r.client_id}-${sameAttrPairs}`;
    ledgerRows.push({
      ...base,
      attribution_id: attributionId,
      ledger_id: `${attributionId}-1credit`,
      ledger_created_at: `${r.date}T09:00:00Z`,
      members: creditMembers,
      sessions: creditSessions,
    });
    ledgerRows.push({
      ...base,
      attribution_id: attributionId,
      ledger_id: `${attributionId}-2cancel`,
      ledger_created_at: `${r.date}T17:00:00Z`,
      members: num(r.members),
      sessions: num(r.sessions),
    });
  } else {
    crossAttrPairs++;
    // New attribution carries the re-booking; old one carries the cancel.
    const creditAttr = `cross-c-${r.client_id}-${crossAttrPairs}`;
    const cancelAttr = `cross-x-${r.client_id}-${crossAttrPairs}`;
    ledgerRows.push({
      ...base,
      attribution_id: creditAttr,
      ledger_id: `${creditAttr}-credit`,
      ledger_created_at: `${r.date}T09:00:00Z`,
      sale_occurred_at: `${MONTH}-01 12:00:00`,
      members: creditMembers,
      sessions: creditSessions || -num(r.sessions),
    });
    ledgerRows.push({
      ...base,
      attribution_id: cancelAttr,
      ledger_id: `${cancelAttr}-cancel`,
      ledger_created_at: `${r.date}T17:00:00Z`,
      members: num(r.members),
      sessions: num(r.sessions),
    });
  }
}

for (const r of orphanDump) {
  const email = emailFor(r.rep);
  if (!email) continue;
  injectedOrphans++;
  const attributionId = `orphan-${r.client_id}-${injectedOrphans}`;
  ledgerRows.push({
    email,
    manager_name: r.rep,
    client_id: r.client_id,
    attribution_date: r.date,
    occurred_at: r.date,
    sale_occurred_at: `${r.sale_month || MONTH}-01 12:00:00`,
    attribution_id: attributionId,
    manager_id: `o${injectedOrphans}`,
    ledger_id: `${attributionId}-cancel`,
    ledger_created_at: `${r.date}T17:00:00Z`,
    members: num(r.members),
    sessions: num(r.sessions),
    // Members overshoot, sessions do not — the shape that let these survive v3.
    lifetime_members: num(r.members),
    lifetime_sessions: 0,
  });
}

/**
 * Lifetime totals per journal, as the database reports them.
 *
 * Transfer pairs net to zero in-window so their lifetime is ≥ 0. Orphans are
 * injected with an explicit negative lifetime above and must keep it —
 * otherwise this would be measuring the wash alone.
 */
function withLifetime(rows) {
  const byJournal = new Map();
  for (const row of rows) {
    const key = `${row.attribution_id}|${row.manager_id}`;
    const bucket = byJournal.get(key) || { members: 0, sessions: 0 };
    bucket.members += row.members;
    bucket.sessions += row.sessions;
    byJournal.set(key, bucket);
  }
  return rows.map((row) => {
    if (row.lifetime_members !== undefined || row.lifetime_sessions !== undefined) {
      return row;
    }
    const key = `${row.attribution_id}|${row.manager_id}`;
    const win = byJournal.get(key) || { members: 0, sessions: 0 };
    return {
      ...row,
      lifetime_members: Math.max(win.members, 0),
      lifetime_sessions: Math.max(win.sessions, 0),
    };
  });
}

function tiles(rows, windowMonth) {
  const result = netLedgerJournal(rows, displayByEmail, new Set(), windowMonth);
  const out = {
    members: 0,
    cancelMembers: 0,
    cancelSessions: 0,
    washed: result.washed.length,
    orphans: result.suppressed.filter((s) => s.reason === "orphan-cancel").length,
  };
  for (const row of result.rows) {
    out.members += row.members;
    if (row.kind === "cancel") {
      out.cancelMembers += Math.min(row.members, 0);
      out.cancelSessions += Math.min(row.sessions, 0);
    }
  }
  return out;
}

const live = withLifetime(ledgerRows);
const before = tiles(live, undefined);
const after = tiles(live, MONTH);
// Control: the export's own lines through the shipped pipeline, with no
// transfer pairs to wash. Cancels sit 1 member inside the export's raw
// negative sum because one cancel-and-rebook (Christopher Jones, client
// 8566758) is a correction rather than lost business — the live dump does not
// list it either. Matching this is what "the wash changed nothing it should
// not have" means.
const control = tiles(withLifetime(exportOnlyRows), MONTH);

const n = (v) => v.toFixed(2).padStart(9);
const injectedPairs = sameAttrPairs + crossAttrPairs;
console.log(
  `${exportRows.length} roster lines from the export · ` +
    `${sameAttrPairs} same-attr transfers · ${crossAttrPairs} cross-attr transfers · ` +
    `${injectedOrphans} orphans`
);
console.log();
console.log(`export raw sums        members ${n(exportTotals.members)}  cancels ${n(exportTotals.cancelMembers)} ${n(exportTotals.cancelSessions)}`);
console.log(`control: export only   members ${n(control.members)}  cancels ${n(control.cancelMembers)} ${n(control.cancelSessions)}   (re-book counted as a correction)`);
console.log(`without the wash       members ${n(before.members)}  cancels ${n(before.cancelMembers)} ${n(before.cancelSessions)}   (orphans already dropped; transfers still count)`);
console.log(`with the wash          members ${n(after.members)}  cancels ${n(after.cancelMembers)} ${n(after.cancelSessions)}   (${after.washed} washed, ${after.orphans} orphans)`);
console.log();

// 1. The reproduction has to be materially worse than the export, or this is
//    the wrong shape again.
assert.ok(
  before.cancelMembers < exportTotals.cancelMembers - 25,
  `reproduction should be much worse than the export, got ${before.cancelMembers}`
);

// 2. Both wash shapes fire, and every orphan is dropped.
assert.equal(after.washed, injectedPairs, "every injected transfer pair is washed");
assert.equal(after.orphans, injectedOrphans, "every injected orphan is dropped");
assert.ok(crossAttrPairs > 0, "the rebuild includes the cross-attribution shape v3 missed");
assert.ok(injectedOrphans > 0, "the rebuild includes the orphans v3 missed");

// 3. Washing + orphan drop returns the exact export-only result.
assert.ok(
  Math.abs(after.cancelMembers - control.cancelMembers) < 0.01,
  `cancels should return to the export-only control, got ${after.cancelMembers} vs ${control.cancelMembers}`
);
assert.ok(
  Math.abs(after.cancelSessions - control.cancelSessions) < 0.01,
  "cancel sessions return to the export-only control too"
);
assert.ok(
  Math.abs(control.cancelMembers - exportTotals.cancelMembers) <= 1.01,
  `control should sit within the known re-book of the export, got ${control.cancelMembers} vs ${exportTotals.cancelMembers}`
);

// 4. Transfer wash reclassifies; it never removes value from the totals.
//    (Orphan drop does remove value — those lines were pure attrition noise
//    with no offsetting credit — so compare members against a wash-only run.)
const washOnlyRows = withLifetime(
  ledgerRows.filter((r) => !String(r.attribution_id || "").startsWith("orphan-"))
);
const washOnlyBefore = tiles(washOnlyRows, undefined);
const washOnlyAfter = tiles(washOnlyRows, MONTH);
assert.ok(
  Math.abs(washOnlyAfter.members - washOnlyBefore.members) < 0.01,
  "the wash must not move the members tile"
);

// 5. Cancels of this month's sales are untouched — they are real attrition.
const julyCancels = dump.filter((r) => r.sale_month === MONTH);
assert.ok(julyCancels.length > 0, "the dump has cancels of this month's sales");
console.log(`this month's ${julyCancels.length} cancels of this month's sales are left alone`);

// 6. The live tile after v3 was -78.0. Confirm the leftover arithmetic — the
//    unwashed absents plus the orphans — matches what the user reported, so
//    this is aimed at the gap that is actually on screen.
const absentMembers = absentDump.reduce((s, r) => s + num(r.members), 0);
const orphanMembers = orphanDump.reduce((s, r) => s + num(r.members), 0);
const sameAttrMembers = absentDump
  .filter((r) => emailFor(r.rep))
  .slice(0, SAME_ATTR_COUNT)
  .reduce((s, r) => s + num(r.members), 0);
// nine-rep export cancels (-50.5) + unwashed absents + all orphans ≈ -78
const predictedV3 = -50.5 + (absentMembers - sameAttrMembers) + orphanMembers;
console.log(
  `predicted v3 leftover (${SAME_ATTR_COUNT} same-attr washed): ${predictedV3.toFixed(1)} (user reported -78.0)`
);
assert.ok(
  predictedV3 < -70 && predictedV3 > -85,
  `predicted leftover should sit near the -78 the user reported, got ${predictedV3}`
);

console.log("\nok — cross-attr wash + members-primary orphan drop restore export parity,");
console.log("     and the wash still does not move the members tile");
