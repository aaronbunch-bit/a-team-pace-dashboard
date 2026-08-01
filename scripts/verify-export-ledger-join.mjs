/**
 * Join the live cancel dump onto a rep-scores export by ledger id, and prove
 * the shipped journal drops what the export drops.
 *
 * Run against real files:
 *   node scripts/verify-export-ledger-join.mjs <live-cancels.csv> <export.csv>
 * Run the embedded July 2026 evidence (this is what `npm test` does):
 *   node scripts/verify-export-ledger-join.mjs
 *
 * Why this script exists
 * ----------------------
 * Five releases in a row moved the cancel tile by reasoning about what the
 * export *probably* did. Both files carry `ledger_id`, so they can simply be
 * joined, and the July 2026 join is unambiguous:
 *
 *   58 lines  -50.5  in the export      <- the number the reps reconcile against
 *   25 lines  -22.0  client absent from the export entirely
 *   10 lines   -5.5  attribution in the export, this rep no longer on it
 *   --------------------------------
 *   93 lines  -78.0  what the tile counted
 *
 * The 10 split again by who the ledger paid instead. For 8 of them (-4.0) the
 * same write gave positive credit to a *different* rep: the sale moved, and the
 * export lists only the reps holding the attribution now. Those are what the
 * v5 `transferred_out` wash removes, and this script proves the wash takes
 * exactly those 8 and none of the 58.
 *
 * The remaining 27 lines (-23.5) are the business-date population: the export
 * windows the month on a ledger date the pacer does not read, so a June-dated
 * reversal written in July belongs to June's export and lands in our July
 * window. They are indistinguishable from the 42 prior-month cancels the export
 * *does* keep on every column the query currently selects — which is why the
 * fix ships the month-key candidate diagnostic instead of a sixth guess.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { netLedgerJournal } from "../functions/get-live-actuals.mts";

/**
 * The July 2026 dump, already joined to the export.
 *
 * [date, rep, clientId, members, sessions, saleMonth, attributionId, ledgerId,
 *  attrWindowCredit, inExport, transferredOut]
 *
 * `inExport` and `transferredOut` are the join results, not predictions: the
 * first is whether the export has that ledger id, the second is whether the
 * export still lists this rep on that attribution.
 */
const JULY = [
  ["2026-07-31", "Tim Carr", "8562850", -1.0, -4.0, "2026-07", "83797", "675212", 1.0, 1, 0],
  ["2026-07-30", "David Valverde", "8561175", -1.0, -4.0, "2026-06", "82149", "674865", 0.0, 1, 0],
  ["2026-07-30", "Chris Jones", "8561181", -1.0, -4.0, "2026-06", "82152", "674866", 0.0, 1, 0],
  ["2026-07-29", "Brenda Wong", "8560967", -1.0, -8.0, "2026-06", "81926", "674519", 0.0, 1, 0],
  ["2026-07-29", "David Valverde", "8561023", -1.0, -8.0, "2026-06", "81980", "674461", 0.0, 1, 0],
  ["2026-07-29", "Chris Jones", "8561071", -1.0, -4.0, "2026-06", "82024", "674492", 0.0, 0, 0],
  ["2026-07-29", "Amanda Schaefer", "8568286", -0.5, -2.0, "2026-07", "87113", "674717", 0.5, 0, 1],
  ["2026-07-28", "David Valverde", "8560766", -1.0, -8.0, "2026-06", "81726", "674089", 0.0, 1, 0],
  ["2026-07-28", "Becky Ruffer", "8560770", -0.5, -2.0, "2026-06", "81727", "674092", 0.0, 1, 0],
  ["2026-07-28", "Brenda Wong", "8567610", -1.0, -12.0, "2026-07", "86414", "674245", 1.0, 1, 0],
  ["2026-07-28", "Liz Weiss", "8560830", -0.5, -2.0, "2026-06", "81791", "674105", 0.0, 1, 0],
  ["2026-07-28", "Liz Weiss", "8568063", -0.5, -2.0, "2026-07", "86867", "674298", 0.5, 0, 1],
  ["2026-07-27", "Domenica Sorrentino", "8560681", -1.0, -8.0, "2026-06", "81625", "673759", 0.0, 0, 0],
  ["2026-07-27", "Brenda Wong", "8563108", -1.0, -12.0, "2026-07", "84056", "673963", 1.0, 1, 0],
  ["2026-07-26", "Jenna Salupo", "8560469", -1.0, -4.0, "2026-06", "81436", "673572", 0.0, 1, 0],
  ["2026-07-26", "Liz Weiss", "8560447", -1.0, -4.0, "2026-06", "81409", "673562", 0.0, 1, 0],
  ["2026-07-25", "Liz Weiss", "8560430", -1.0, -4.0, "2026-06", "81386", "673406", 0.0, 1, 0],
  ["2026-07-25", "Del Ali", "8557188", -1.0, -8.0, "2026-06", "78314", "673413", 0.0, 1, 0],
  ["2026-07-24", "Del Ali", "8560219", -0.5, -4.0, "2026-06", "81173", "673042", 0.0, 0, 0],
  ["2026-07-24", "Chris Jones", "8561761", -1.0, -6.0, "2026-07", "82765", "673113", 1.0, 1, 0],
  ["2026-07-24", "Del Ali", "8567241", -1.0, -8.0, "2026-07", "86028", "673182", 1.0, 1, 0],
  ["2026-07-24", "Jenna Salupo", "8567407", -0.5, -4.0, "2026-07", "86203", "673181", 0.5, 1, 0],
  ["2026-07-24", "Jordan Sturdivant", "8560114", -0.5, -2.0, "2026-06", "81065", "673017", 0.0, 1, 0],
  ["2026-07-24", "Jenna Salupo", "8560199", -0.5, -4.0, "2026-06", "81150", "673034", 0.0, 0, 0],
  ["2026-07-24", "Del Ali", "8560216", -0.5, -2.0, "2026-06", "81169", "673040", 0.0, 1, 0],
  ["2026-07-23", "Liz Weiss", "8559997", -1.0, -8.0, "2026-06", "80954", "672756", 0.0, 1, 0],
  ["2026-07-23", "Becky Ruffer", "8567062", -1.0, -8.0, "2026-07", "85853", "672910", 1.0, 1, 0],
  ["2026-07-23", "David Valverde", "8559924", -1.0, -8.0, "2026-06", "80882", "672671", 0.0, 1, 0],
  ["2026-07-23", "Becky Ruffer", "8559843", -1.0, -8.0, "2026-06", "80803", "672711", 0.0, 1, 0],
  ["2026-07-23", "Amanda Schaefer", "8567416", -0.5, -4.0, "2026-07", "86209", "672971", 0.5, 0, 1],
  ["2026-07-22", "Jordan Sturdivant", "8567166", -0.5, -4.0, "2026-07", "85950", "672494", 0.5, 0, 1],
  ["2026-07-21", "Becky Ruffer", "8559469", -1.0, -8.0, "2026-06", "80465", "671989", 0.0, 0, 0],
  ["2026-07-21", "Becky Ruffer", "8558294", -1.0, -8.0, "2026-06", "79388", "672090", 0.0, 1, 0],
  ["2026-07-20", "Del Ali", "8566520", -1.0, -8.0, "2026-07", "85337", "671704", 1.0, 1, 0],
  ["2026-07-20", "Liz Weiss", "8559340", -1.0, -4.0, "2026-06", "80317", "671568", 0.0, 0, 0],
  ["2026-07-20", "Liz Weiss", "8559348", -1.0, -8.0, "2026-06", "80322", "671575", 0.0, 0, 0],
  ["2026-07-19", "Chris Jones", "8559213", -1.0, -4.0, "2026-06", "80178", "671358", 0.0, 1, 0],
  ["2026-07-19", "Liz Weiss", "8559247", -1.0, -4.0, "2026-06", "80206", "671375", 0.0, 1, 0],
  ["2026-07-18", "Jenna Salupo", "8558891", -1.0, -4.0, "2026-06", "79872", "671132", 0.0, 1, 0],
  ["2026-07-18", "Chris Jones", "8555924", -0.5, -4.0, "2026-06", "77173", "671134", 0.0, 1, 0],
  ["2026-07-17", "Domenica Sorrentino", "8563672", -0.5, -8.0, "2026-07", "84505", "670903", 0.5, 1, 0],
  ["2026-07-17", "Becky Ruffer", "8563672", -0.5, -8.0, "2026-07", "84505", "670902", 0.5, 1, 0],
  ["2026-07-17", "Jordan Sturdivant", "8563960", -0.5, -2.0, "2026-07", "84776", "671081", 0.5, 1, 0],
  ["2026-07-17", "Jenna Salupo", "8558620", -1.0, -4.0, "2026-06", "80112", "670709", 0.0, 1, 0],
  ["2026-07-17", "Del Ali", "8558683", -0.5, -4.0, "2026-06", "79738", "670742", 0.0, 1, 0],
  ["2026-07-16", "David Valverde", "8558429", -1.0, -8.0, "2026-06", "79515", "670347", 0.0, 1, 0],
  ["2026-07-16", "Del Ali", "8558517", -1.0, -4.0, "2026-06", "79585", "670442", 0.0, 1, 0],
  ["2026-07-15", "Jenna Salupo", "8558325", -0.5, -2.0, "2026-06", "79417", "669962", 0.0, 1, 0],
  ["2026-07-15", "Chris Jones", "8558251", -1.0, -8.0, "2026-06", "79347", "670014", 0.0, 0, 0],
  ["2026-07-14", "Jenna Salupo", "8557987", -0.5, -4.0, "2026-06", "79105", "669600", 0.0, 1, 0],
  ["2026-07-14", "David Valverde", "8557996", -0.5, -2.0, "2026-06", "79112", "669606", 0.0, 0, 0],
  ["2026-07-14", "Domenica Sorrentino", "8558027", -1.0, -4.0, "2026-06", "79145", "669614", 0.0, 0, 0],
  ["2026-07-13", "Chris Jones", "8557966", -1.0, -4.0, "2026-06", "79064", "669220", 0.0, 1, 0],
  ["2026-07-12", "Jenna Salupo", "8557792", -1.0, -4.0, "2026-06", "78865", "668997", 0.0, 1, 0],
  ["2026-07-12", "Domenica Sorrentino", "8557863", -1.0, -8.0, "2026-06", "78935", "669006", 0.0, 0, 0],
  ["2026-07-12", "Liz Weiss", "8557776", -1.0, -4.0, "2026-06", "78854", "669007", 0.0, 0, 0],
  ["2026-07-12", "Jenna Salupo", "8557699", -1.0, -4.0, "2026-06", "78780", "669010", 0.0, 0, 0],
  ["2026-07-12", "Del Ali", "8557780", -1.0, -8.0, "2026-06", "78856", "669029", 0.0, 0, 0],
  ["2026-07-12", "Brenda Wong", "8557864", -0.5, -4.0, "2026-06", "78931", "669060", 0.0, 0, 0],
  ["2026-07-11", "Domenica Sorrentino", "8557590", -1.0, -8.0, "2026-06", "78664", "668781", 0.0, 1, 0],
  ["2026-07-11", "David Valverde", "8557457", -1.0, -8.0, "2026-06", "78592", "668791", 0.0, 1, 0],
  ["2026-07-10", "Chris Jones", "8562447", -1.0, -8.0, "2026-07", "83401", "668450", 1.0, 1, 0],
  ["2026-07-10", "David Valverde", "8557205", -1.0, -8.0, "2026-06", "78359", "668284", 0.0, 1, 0],
  ["2026-07-10", "Del Ali", "8557336", -1.0, -4.0, "2026-06", "78450", "668332", 0.0, 1, 0],
  ["2026-07-10", "Del Ali", "8557443", -0.5, -4.0, "2026-06", "78550", "668366", 0.0, 1, 0],
  ["2026-07-10", "Chris Jones", "8557392", -1.0, -8.0, "2026-06", "78503", "668376", 0.0, 1, 0],
  ["2026-07-10", "Brenda Wong", "8563076", -1.0, -4.0, "2026-07", "84017", "668593", 1.0, 1, 0],
  ["2026-07-09", "Brenda Wong", "8562185", -1.0, -4.0, "2026-07", "83168", "667892", 1.0, 1, 0],
  ["2026-07-09", "Brenda Wong", "8557077", -1.0, -8.0, "2026-06", "78216", "667798", 0.0, 1, 0],
  ["2026-07-09", "Jenna Salupo", "8557181", -1.0, -4.0, "2026-06", "78309", "667830", 0.0, 0, 0],
  ["2026-07-08", "Brenda Wong", "8562128", -1.0, -4.0, "2026-07", "83111", "667569", 1.0, 1, 0],
  ["2026-07-08", "Chris Jones", "8556758", -1.0, -4.0, "2026-06", "77969", "667330", 0.0, 1, 0],
  ["2026-07-08", "Chris Jones", "8556873", -1.0, -8.0, "2026-06", "78068", "667373", 0.0, 1, 0],
  ["2026-07-08", "Chris Jones", "8556927", -1.0, -8.0, "2026-06", "78116", "667378", 0.0, 1, 0],
  ["2026-07-07", "Becky Ruffer", "8556569", -1.0, -8.0, "2026-06", "77803", "666899", 0.0, 1, 0],
  ["2026-07-07", "Becky Ruffer", "8556587", -0.5, -4.0, "2026-06", "77817", "666912", 0.0, 1, 0],
  ["2026-07-06", "Del Ali", "8556468", -1.0, -4.0, "2026-06", "77678", "666503", 0.0, 0, 0],
  ["2026-07-06", "Liz Weiss", "8556473", -1.0, -4.0, "2026-06", "77685", "666505", 0.0, 0, 0],
  ["2026-07-06", "Chris Jones", "8556508", -0.5, -2.0, "2026-06", "77722", "666524", 0.0, 0, 0],
  ["2026-07-05", "Jenna Salupo", "8556328", -0.5, -2.0, "2026-06", "77508", "666318", 0.0, 0, 0],
  ["2026-07-03", "Becky Ruffer", "8561610", -0.5, -2.0, "2026-07", "82605", "666005", 0.5, 1, 0],
  ["2026-07-03", "Chris Jones", "8555756", -1.0, -4.0, "2026-06", "77025", "665824", 0.0, 0, 0],
  ["2026-07-03", "Brenda Wong", "8555760", -1.0, -4.0, "2026-06", "77033", "665825", 0.0, 0, 0],
  ["2026-07-03", "David Valverde", "8555802", -1.0, -4.0, "2026-06", "77068", "665831", 0.0, 0, 0],
  ["2026-07-03", "David Valverde", "8555708", -1.0, -4.0, "2026-06", "77004", "665841", 0.0, 0, 0],
  ["2026-07-03", "Brenda Wong", "8555847", -1.0, -12.0, "2026-06", "77100", "665852", 0.0, 0, 0],
  ["2026-07-03", "Jenna Salupo", "8555039", -1.0, -8.0, "2026-06", "76516", "666019", 0.0, 1, 0],
  ["2026-07-02", "Becky Ruffer", "8555523", -0.5, -4.0, "2026-06", "76849", "665472", 0.0, 0, 0],
  ["2026-07-02", "Jordan Sturdivant", "8561548", -0.5, -4.0, "2026-07", "82536", "665511", 0.5, 0, 1],
  ["2026-07-02", "Amanda Schaefer", "8561639", -0.5, -6.0, "2026-07", "82629", "665697", 0.5, 0, 1],
  ["2026-07-01", "Chris Jones", "8555278", -1.0, -4.0, "2026-06", "76697", "665038", 0.0, 0, 0],
  ["2026-07-01", "Del Ali", "8561317", -0.5, -2.0, "2026-07", "82304", "665095", 0.5, 0, 1],
  ["2026-07-01", "Del Ali", "8561424", -0.5, -4.0, "2026-07", "82412", "665285", 0.5, 0, 1]
];

const num = (v) => Number(v) || 0;
const REPS = [...new Set(JULY.map((r) => r[1]))];
const emailFor = (rep) => `${rep.toLowerCase().replace(/[^a-z]+/g, ".")}@varsitytutors.com`;
const DISPLAY = Object.fromEntries(REPS.map((rep) => [emailFor(rep), rep]));
const MANAGER_ID = Object.fromEntries(REPS.map((rep, i) => [rep, String(2200 + i)]));

/**
 * Rebuild the ledger rows behind a dump line.
 *
 * A dump line is a surviving cancel, so it always has its own negative row. It
 * also gets the in-window credit the diagnostics measured (`attrWindowCredit`),
 * which is what a wash folds the cancel back into. Lifetime is zero on all 93 —
 * every one of these cancels exactly offsets its rep's credit — so the lifetime
 * overshoot rule cannot separate them and is not what is under test here.
 */
function ledgerRows({ withTransferFlag = true } = {}) {
  const rows = [];
  JULY.forEach(([date, rep, clientId, members, sessions, saleMonth, attributionId, ledgerId, credit, , transferredOut]) => {
    const email = emailFor(rep);
    const base = {
      email,
      manager_name: rep,
      client_id: clientId,
      attribution_id: attributionId,
      manager_id: MANAGER_ID[rep],
      sale_occurred_at: `${saleMonth}-15 12:00:00`,
      lifetime_members: 0,
      lifetime_sessions: 0,
    };
    if (credit > 0) {
      rows.push({
        ...base,
        ledger_id: `c${ledgerId}`,
        attribution_date: date,
        occurred_at: `${date} 09:00:00`,
        ledger_created_at: `${date}T09:00:00Z`,
        members: credit,
        sessions: -sessions,
      });
    }
    rows.push({
      ...base,
      ledger_id: ledgerId,
      attribution_date: date,
      occurred_at: `${date} 12:00:00`,
      ledger_created_at: `${date}T12:00:00Z`,
      members,
      sessions,
      transferred_out: withTransferFlag ? transferredOut === 1 : false,
    });
  });
  return rows;
}

const tile = (rows) => {
  const out = netLedgerJournal(rows, DISPLAY, new Set(), "2026-07");
  const cancels = out.rows.filter((r) => r.kind === "cancel");
  return {
    members: out.rows.reduce((s, r) => s + num(r.members), 0),
    cancelLines: cancels.length,
    cancelMembers: cancels.reduce((s, r) => s + num(r.members), 0),
    washedIds: new Set(out.washed.map((w) => w.ledgerId)),
  };
};

const fmt = (n) => (Math.round(n * 100) / 100).toFixed(1);

function readCsv(text) {
  const lines = text.trim().split(/\r?\n/).filter((l) => l && !l.startsWith("#"));
  const cols = lines[0].split(",");
  return lines.slice(1).map((line) => {
    const cells = line.split(",");
    return Object.fromEntries(cols.map((c, i) => [c, cells[i] ?? ""]));
  });
}

/** Join a real dump onto a real export and print the three populations. */
function joinFiles(livePath, exportPath) {
  const live = readCsv(readFileSync(livePath, "utf8"));
  const exp = readCsv(readFileSync(exportPath, "utf8"));
  const byLedger = new Map(exp.map((r) => [r.ledger_id, r]));
  const byAttribution = new Map();
  for (const r of exp) {
    const bucket = byAttribution.get(r.attribution_id);
    if (bucket) bucket.push(r);
    else byAttribution.set(r.attribution_id, [r]);
  }
  const kept = [];
  const absent = [];
  const moved = [];
  for (const row of live) {
    if (byLedger.has(row.ledger_id)) kept.push(row);
    else if (byAttribution.has(row.attribution_id)) moved.push(row);
    else absent.push(row);
  }
  const sum = (rows) => rows.reduce((s, r) => s + num(r.members), 0);
  const show = (label, rows) => console.log(`${label.padEnd(34)} ${String(rows.length).padStart(3)} lines  ${fmt(sum(rows)).padStart(7)} members`);
  console.log(`\njoined ${live.length} dump lines onto ${exp.length} export rows by ledger_id\n`);
  show("in the export (keep)", kept);
  show("attribution moved to another rep", moved);
  show("absent from the export", absent);
  show("total", live);

  // Which date column on the dump reproduces the export's population? Any extra
  // column whose July values keep exactly the export's lines is the month key.
  const known = new Set([
    "date", "rep", "client_id", "members", "sessions", "sale_month",
    "attribution_id", "ledger_id", "lifetime_members", "attr_credit",
    "client_rep_credit", "transferred_out",
  ]);
  const candidates = Object.keys(live[0] || {}).filter((c) => !known.has(c));
  if (candidates.length) {
    const month = (live[0].date || "").slice(0, 7);
    console.log(`\nmonth-key candidates against ${month}:\n`);
    for (const col of candidates) {
      const inMonth = live.filter((r) => String(r[col] || "").startsWith(month));
      const missesKept = kept.filter((r) => !String(r[col] || "").startsWith(month)).length;
      const keepsDropped = [...moved, ...absent].filter((r) => String(r[col] || "").startsWith(month)).length;
      console.log(
        `  ${col.padEnd(26)} ${String(inMonth.length).padStart(3)} lines ${fmt(sum(inMonth)).padStart(7)}`
        + `   drops ${missesKept} the export keeps, keeps ${keepsDropped} it drops`
      );
    }
    console.log("\nthe column that drops 0 and keeps only the transfers is the export's month key.");
  }
}

const [livePath, exportPath] = process.argv.slice(2);
if (livePath && exportPath) {
  joinFiles(livePath, exportPath);
  process.exit(0);
}

// ---- Embedded July 2026 evidence ------------------------------------------

const exportKeeps = JULY.filter((r) => r[9] === 1);
const movedRep = JULY.filter((r) => r[9] === 0 && r[10] === 1);
const businessDate = JULY.filter((r) => r[9] === 0 && r[10] === 0);
const sumOf = (rows) => rows.reduce((s, r) => s + r[3], 0);

assert.equal(JULY.length, 93, "the July dump had 93 cancel lines");
assert.equal(fmt(sumOf(JULY)), "-78.0", "and totalled -78.0 on the tile");
assert.equal(exportKeeps.length, 58);
assert.equal(fmt(sumOf(exportKeeps)), "-50.5", "the export keeps 58 of them, at the manual -50.5");
assert.equal(movedRep.length, 8);
assert.equal(fmt(sumOf(movedRep)), "-4.0", "8 lines had the sale moved to another rep");
assert.equal(businessDate.length, 27);
assert.equal(fmt(sumOf(businessDate)), "-23.5", "27 lines are the business-date population");

// 1. Without the flag the tile is what the user reported: nothing has moved.
const before = tile(ledgerRows({ withTransferFlag: false }));
assert.equal(before.cancelLines, 93);
assert.equal(fmt(before.cancelMembers), "-78.0");

// 2. With it, exactly the 8 transferred lines wash out.
const after = tile(ledgerRows());
assert.equal(after.washedIds.size, 8, "the wash takes 8 lines");
for (const row of movedRep) {
  assert.ok(after.washedIds.has(row[7]), `ledger ${row[7]} (${row[1]}) should wash`);
}
for (const row of exportKeeps) {
  assert.ok(!after.washedIds.has(row[7]), `ledger ${row[7]} (${row[1]}) is a real cancel the export counts`);
}
assert.equal(after.cancelLines, 85);
assert.equal(fmt(after.cancelMembers), "-74.0");

// 3. A wash reclassifies; it must never move the members tile.
assert.equal(
  fmt(before.members),
  fmt(after.members),
  "washing a transfer drops the credit with the cancel, so members is unchanged"
);

// 4. Same-month cancels that are still this rep's business are untouched. This
//    is the check that keeps the flag honest: 16 of the export's own cancels
//    are same-month, exactly the shape the wash removes, and they must stay.
const sameMonthKept = exportKeeps.filter((r) => r[5] === "2026-07");
assert.equal(sameMonthKept.length, 16);
for (const row of sameMonthKept) {
  assert.ok(!after.washedIds.has(row[7]), `same-month cancel ${row[7]} must survive`);
}

console.log(`export join      ${exportKeeps.length} lines  ${fmt(sumOf(exportKeeps))}  (manual target)`);
console.log(`transfer wash    ${movedRep.length} lines  ${fmt(sumOf(movedRep))}  removed by v5`);
console.log(`business date    ${businessDate.length} lines  ${fmt(sumOf(businessDate))}  still on the tile, needs the month key`);
console.log(`tile             ${before.cancelLines} -> ${after.cancelLines} lines, ${fmt(before.cancelMembers)} -> ${fmt(after.cancelMembers)} members`);
console.log("\nok — the v5 wash removes every transferred line and no cancel the export counts");
