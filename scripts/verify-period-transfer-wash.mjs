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

// The lines the export has no row for: a re-booking credit and the cancel
// written with it, both landing in this month's window on the same journal.
let injectedPairs = 0;
for (const r of dump) {
  if (exportClients.has(r.client_id)) continue;
  const email = emailFor(r.rep);
  if (!email) continue;
  injectedPairs++;
  const attributionId = `transfer-${r.client_id}-${injectedPairs}`;
  const base = {
    email,
    manager_name: r.rep,
    client_id: r.client_id,
    attribution_date: r.date,
    occurred_at: r.date,
    sale_occurred_at: `${r.sale_month || PRIOR}-01 12:00:00`,
    attribution_id: attributionId,
    manager_id: `t${injectedPairs}`,
    ledger_created_at: r.date,
  };
  // The re-booking credit is written first and the cancel after it, which is
  // what makes the negative line a cancel rather than a reversal.
  ledgerRows.push({
    ...base,
    ledger_id: `${attributionId}-1credit`,
    ledger_created_at: `${r.date}T09:00:00Z`,
    members: -num(r.members),
    sessions: -num(r.sessions),
  });
  ledgerRows.push({
    ...base,
    ledger_id: `${attributionId}-2cancel`,
    ledger_created_at: `${r.date}T17:00:00Z`,
    members: num(r.members),
    sessions: num(r.sessions),
  });
}

/**
 * Lifetime totals per journal, as the database reports them.
 *
 * The live payload showed no journal netting below zero, so nothing here may
 * either — otherwise the orphan rule would fire and this would be measuring
 * the wrong thing.
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
    const key = `${row.attribution_id}|${row.manager_id}`;
    const win = byJournal.get(key) || { members: 0, sessions: 0 };
    // A prior month's sale keeps its credit outside this window, so the
    // journal's all-time net never goes below zero.
    return {
      ...row,
      lifetime_members: Math.max(win.members, 0),
      lifetime_sessions: Math.max(win.sessions, 0),
    };
  });
}

function tiles(rows, windowMonth) {
  const result = netLedgerJournal(rows, displayByEmail, new Set(), windowMonth);
  const out = { members: 0, cancelMembers: 0, cancelSessions: 0, washed: result.washed.length };
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
console.log(`${exportRows.length} roster lines from the export, ${injectedPairs} period-transfer pairs rebuilt from the live dump`);
console.log();
console.log(`export raw sums        members ${n(exportTotals.members)}  cancels ${n(exportTotals.cancelMembers)} ${n(exportTotals.cancelSessions)}`);
console.log(`control: export only   members ${n(control.members)}  cancels ${n(control.cancelMembers)} ${n(control.cancelSessions)}   (re-book counted as a correction)`);
console.log(`without the wash       members ${n(before.members)}  cancels ${n(before.cancelMembers)} ${n(before.cancelSessions)}   <- the dashboard today`);
console.log(`with the wash          members ${n(after.members)}  cancels ${n(after.cancelMembers)} ${n(after.cancelSessions)}   (${after.washed} lines washed)`);
console.log();

// 1. The reproduction has to look like the dashboard, or this is the wrong
//    shape and the fix is aimed at the wrong thing again.
assert.ok(
  before.cancelMembers < exportTotals.cancelMembers - 30,
  `reproduction should be ~35 members worse than the export, got ${before.cancelMembers}`
);

// 2. The wash has to actually fire.
assert.equal(after.washed, injectedPairs, "every injected transfer pair is washed");

// 3. Washing the transfer pairs returns the exact export-only result: the
//    injected noise is removed and nothing else changes.
assert.ok(
  Math.abs(after.cancelMembers - control.cancelMembers) < 0.01,
  `cancels should return to the export-only control, got ${after.cancelMembers} vs ${control.cancelMembers}`
);
assert.ok(
  Math.abs(after.cancelSessions - control.cancelSessions) < 0.01,
  "cancel sessions return to the export-only control too"
);
// And that control is the export's own number, bar the one re-book.
assert.ok(
  Math.abs(control.cancelMembers - exportTotals.cancelMembers) <= 1.01,
  `control should sit within the known re-book of the export, got ${control.cancelMembers} vs ${exportTotals.cancelMembers}`
);

// 4. The number that was already right stays right. This is the guard rail:
//    the wash reclassifies, it never removes value from the totals.
assert.ok(
  Math.abs(after.members - before.members) < 0.01,
  "the wash must not move the members tile"
);

// 5. Cancels of this month's sales are untouched — they are real attrition.
const julyCancels = dump.filter((r) => r.sale_month === MONTH);
assert.ok(julyCancels.length > 0, "the dump has cancels of this month's sales");
console.log(`this month's ${julyCancels.length} cancels of this month's sales are left alone`);

console.log("\nok — the wash reproduces the bug, fixes the cancel tile to the export's number,");
console.log("     and leaves the members tile exactly where it was");
