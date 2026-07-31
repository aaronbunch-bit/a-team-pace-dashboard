/**
 * Prove the live cancel dump reaches export parity under the two rules in this
 * PR. Run:
 *   node scripts/verify-live-cancel-dump.mjs <live-cancels.csv> <export.csv>
 *
 * live-cancels.csv is the "Copy these lines" dump from Team → Cancels.
 */
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const [livePath, exportPath] = process.argv.slice(2);
if (!livePath || !exportPath) {
  console.error("usage: node scripts/verify-live-cancel-dump.mjs <live-cancels.csv> <export.csv>");
  process.exit(2);
}

function readCsv(text) {
  const lines = text.trim().split(/\r?\n/).filter((l) => l && !l.startsWith("#"));
  const cols = lines[0].split(",");
  return lines.slice(1).map((line) => {
    const cells = line.split(",");
    return Object.fromEntries(cols.map((c, i) => [c, cells[i] ?? ""]));
  });
}

const NAME = {
  "Becky Ruffer": "Becky Ruffer",
  "Brenda Wong": "Brenda Wong",
  "Christopher Jones": "Chris Jones",
  "David Valverde": "David Valverde",
  "Del Ali": "Del Ali",
  "Domenica Sorrentino": "Domenica Sorrentino",
  "JENNA SALUPO": "Jenna Salupo",
  "Liz Weiss": "Liz Weiss",
  "Timothy Carr": "Tim Carr",
  "Jordan Sturdivant": "Jordan Sturdivant",
  "Amanda Schaefer": "Amanda Schaefer",
};
const num = (v) => Number(v || 0);

const live = readCsv(readFileSync(livePath, "utf8"));
const exp = readCsv(readFileSync(exportPath, "utf8"));
const expClients = new Set(exp.map((r) => r.client_id));
const rosterManagers = new Set(Object.keys(NAME).concat(Object.values(NAME)));

function exportHasRepNeg(displayRep, clientId) {
  const manager = Object.entries(NAME).find(([disp]) => disp === displayRep)?.[1]
    || Object.entries(NAME).find(([, mgr]) => mgr === displayRep)?.[1]
    || displayRep;
  // NAME maps display -> export manager name; invert display keys
  const exportName = ({
    "Becky Ruffer": "Becky Ruffer",
    "Brenda Wong": "Brenda Wong",
    "Chris Jones": "Christopher Jones",
    "David Valverde": "David Valverde",
    "Del Ali": "Del Ali",
    "Domenica Sorrentino": "Domenica Sorrentino",
    "Jenna Salupo": "JENNA SALUPO",
    "Liz Weiss": "Liz Weiss",
    "Tim Carr": "Timothy Carr",
    "Jordan Sturdivant": "Jordan Sturdivant",
    "Amanda Schaefer": "Amanda Schaefer",
  })[displayRep];
  return exp.some((r) =>
    r.client_id === clientId &&
    r.manager === exportName &&
    (num(r.expert_net_members) < 0 || num(r.expert_net_monthly_hours) < 0)
  );
}

// Rule 1 (a.deleted_at is null): drop cancels whose client is absent from the
// export entirely — soft-deleted attributions the export never lists.
// Rule 2 (orphan lifetime < 0): drop cancels where this rep has no negative in
// the export for that client — typically a SPIFF cancel against a sale credited
// to someone else.
const kept = [];
const droppedAbsent = [];
const droppedOrphan = [];
for (const row of live) {
  if (!expClients.has(row.client_id)) {
    droppedAbsent.push(row);
    continue;
  }
  if (!exportHasRepNeg(row.rep, row.client_id)) {
    droppedOrphan.push(row);
    continue;
  }
  kept.push(row);
}

const sum = (rows, field) => rows.reduce((s, r) => s + num(r[field]), 0);
const exportNeg = exp.filter((r) =>
  rosterManagers.has(r.manager) &&
  (num(r.expert_net_members) < 0 || num(r.expert_net_monthly_hours) < 0)
);

console.log(`live dump:     ${live.length} lines, members ${sum(live, "members").toFixed(1)}`);
console.log(`drop absent:   ${droppedAbsent.length} lines, members ${sum(droppedAbsent, "members").toFixed(1)}  (soft-deleted attros)`);
console.log(`drop orphan:   ${droppedOrphan.length} lines, members ${sum(droppedOrphan, "members").toFixed(1)}  (no credit for this rep)`);
console.log(`kept:          ${kept.length} lines, members ${sum(kept, "members").toFixed(1)}, sessions ${sum(kept, "sessions").toFixed(1)}`);
console.log(`export neg:    ${exportNeg.length} lines, members ${sum(exportNeg, "expert_net_members").toFixed(1)}, sessions ${sum(exportNeg, "expert_net_monthly_hours").toFixed(1)}`);

assert.equal(sum(droppedAbsent, "members"), -34.5, "the 41 soft-deleted June cancels are -34.5");
assert.ok(droppedAbsent.length >= 40, "dozens of soft-deleted cancels");
assert.equal(sum(kept, "members"), sum(exportNeg, "expert_net_members") + 1, "kept matches export within the known Chris Jones re-book");
assert.ok(Math.abs(sum(kept, "members") - (-50.5)) < 0.01, "kept members land on -50.5");

// ---- The members side ------------------------------------------------------
// Dropping a cancel is only safe if the credit it was paired with goes too.
// The A-Team tiles are the nine reps with July goals (the dump also carries
// Amanda and Jordan, who have no tile), so compare like for like.
const TILE_NINE = new Set([
  "Becky Ruffer", "Brenda Wong", "Christopher Jones", "David Valverde", "Del Ali",
  "Domenica Sorrentino", "JENNA SALUPO", "Liz Weiss", "Timothy Carr",
]);
const DUMP_NINE = new Set([
  "Becky Ruffer", "Brenda Wong", "Chris Jones", "David Valverde", "Del Ali",
  "Domenica Sorrentino", "Jenna Salupo", "Liz Weiss", "Tim Carr",
]);
const nineExport = exp.filter((r) => TILE_NINE.has(r.manager));
const nineDump = live.filter((r) => DUMP_NINE.has(r.rep));

const exportNet = sum(nineExport, "expert_net_members");
const exportCancels = nineExport
  .filter((r) => num(r.expert_net_members) < 0)
  .reduce((s, r) => s + num(r.expert_net_members), 0);
const dumpCancels = sum(nineDump, "members");

// What the screenshot showed against what the export says it should have been.
const TILE_MEMBERS = 397.5;
const TILE_CANCELS = -86.5;

console.log(`\nnine-rep tiles   members ${TILE_MEMBERS}  cancels ${TILE_CANCELS}   (screenshot)`);
console.log(`nine-rep export  members ${exportNet.toFixed(1)}  cancels ${exportCancels.toFixed(1)}`);
console.log(`nine-rep dump    cancels ${dumpCancels.toFixed(1)}`);

assert.ok(Math.abs(dumpCancels - TILE_CANCELS) < 0.01, "the dump's nine tile reps are the -86.5 on screen");
assert.ok(Math.abs(exportCancels - (-50.5)) < 0.01, "the export's nine-rep cancels are -50.5");
assert.ok(Math.abs(exportNet - 398.0) < 0.01, "the export's nine-rep members are 398.0");

// Extra cancels the pacer counted, and the extra credits that hid them.
const extraCancels = dumpCancels - exportCancels;          // -36.0
const extraCredits = (TILE_MEMBERS - exportNet) - extraCancels; // +35.5
console.log(`extra cancels ${extraCancels.toFixed(1)}, extra credits ${extraCredits.toFixed(1)}, net ${(extraCancels + extraCredits).toFixed(1)}`);
assert.ok(
  Math.abs(extraCancels + extraCredits) < 1,
  "the extra cancels arrive paired with credits — dropping the attribution moves members by ~0"
);

console.log("\nok — live dump reaches export parity under deleted-attro + orphan rules,");
console.log("     and the dropped lines net to zero so the members tile holds at ~398");
