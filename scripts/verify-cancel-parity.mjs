/**
 * End-to-end parity proof for the cancel tiles.
 *
 * Run: node --experimental-strip-types scripts/verify-cancel-parity.mjs <export.csv>
 *
 * Cancelling a prior-month sale takes two ledger lines: one unwinding the credit
 * in the month it was booked, one charging the month the cancel landed in. Both
 * are written when the cancel happens, so the live query (which windows on write
 * time) sees both, while a month's export only ever shows the one belonging to
 * that month.
 *
 * This rebuilds that shape from the export — every prior-month cancel gets its
 * unseen sibling back — runs it through the shipped netLedgerJournal, and checks
 * two things:
 *
 *   1. WITHOUT the lifetime check, the tiles reproduce the wrong number the
 *      dashboard has been showing (~-86.5 members), which is what makes this the
 *      real shape rather than a guess.
 *   2. WITH it, the tiles land back on the export's own totals.
 */
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { netLedgerJournal } from "../functions/get-live-actuals.mts";
import { FALLBACK_ROSTER_EMAILS } from "../functions/_shared/roster.mts";

const csvPath = process.argv[2];
if (!csvPath) {
  console.error("usage: node --experimental-strip-types scripts/verify-cancel-parity.mjs <export.csv>");
  process.exit(2);
}

function readCsv(text) {
  const [head, ...lines] = text.trim().split(/\r?\n/);
  const cols = head.split(",");
  return lines.map((line) => {
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

const squash = (name) => String(name || "").toLowerCase().replace(/[^a-z]/g, "");
const emailByName = new Map();
for (const [email, display] of Object.entries(FALLBACK_ROSTER_EMAILS)) {
  emailByName.set(squash(display), email);
  emailByName.set(squash(email.split("@")[0].replace(/[._]/g, " ")), email);
}
const displayByEmail = Object.fromEntries(Object.entries(FALLBACK_ROSTER_EMAILS));

const exportRows = readCsv(readFileSync(csvPath, "utf8"))
  .map((row) => ({ row, email: emailByName.get(squash(row.manager)) }))
  .filter((r) => r.email);

const num = (v) => Number(v || 0);
const MONTH = "2026-07";

const toLedgerRow = ({ row, email }, overrides = {}) => ({
  email,
  manager_name: row.manager,
  client_id: row.client_id,
  attribution_date: row.attribution_date.slice(0, 10),
  occurred_at: row.attribution_date,
  sale_occurred_at: row.conference_id_timestamps.slice(0, 19),
  members: num(row.expert_net_members),
  sessions: num(row.expert_net_monthly_hours),
  ledger_id: row.ledger_id,
  attribution_id: row.attribution_id,
  manager_id: row.manager_id,
  ledger_created_at: row.attribution_date,
  ...overrides,
});

// The export's own totals — the number the reps reconcile against.
const exportTotals = exportRows.reduce(
  (acc, r) => ({
    members: acc.members + num(r.row.expert_net_members),
    sessions: acc.sessions + num(r.row.expert_net_monthly_hours),
    cancelMembers: acc.cancelMembers + Math.min(num(r.row.expert_net_members), 0),
    cancelSessions: acc.cancelSessions + Math.min(num(r.row.expert_net_monthly_hours), 0),
  }),
  { members: 0, sessions: 0, cancelMembers: 0, cancelSessions: 0 }
);

// Rebuild what the database holds: the export's lines, plus the sibling line
// each prior-month cancel also wrote, plus the prior-month credit it unwinds
// (that credit is why the journal still nets to zero over all time).
const ledgerRows = [];
let siblings = 0;
for (const entry of exportRows) {
  const { row } = entry;
  ledgerRows.push(toLedgerRow(entry));
  const isCancel = num(row.expert_net_members) < 0 || num(row.expert_net_monthly_hours) < 0;
  const saleMonth = row.conference_id_timestamps.slice(0, 7);
  if (!isCancel || !saleMonth || saleMonth >= MONTH) continue;
  siblings++;
  // Written now, but booked against the month the sale lived in — invisible to
  // this month's export, visible to a window on write time.
  ledgerRows.push(
    toLedgerRow(entry, {
      ledger_id: `${row.ledger_id}-prior-period`,
      ledger_created_at: row.attribution_date,
    })
  );
}

/** Lifetime totals per journal: the window's lines plus the original credit. */
function withLifetime(rows, { includeOriginalCredit }) {
  const byJournal = new Map();
  for (const row of rows) {
    const key = `${row.attribution_id}|${row.manager_id}`;
    const bucket = byJournal.get(key) || { members: 0, sessions: 0 };
    bucket.members += row.members;
    bucket.sessions += row.sessions;
    byJournal.set(key, bucket);
  }
  // A prior-month sale's credit sits outside this window; add it back so the
  // journal's all-time net is what the database would actually report.
  const priorCredit = new Map();
  if (includeOriginalCredit) {
    for (const entry of exportRows) {
      const { row } = entry;
      const isCancel = num(row.expert_net_members) < 0 || num(row.expert_net_monthly_hours) < 0;
      const saleMonth = row.conference_id_timestamps.slice(0, 7);
      if (!isCancel || !saleMonth || saleMonth >= MONTH) continue;
      const key = `${row.attribution_id}|${row.manager_id}`;
      const bucket = priorCredit.get(key) || { members: 0, sessions: 0 };
      bucket.members += -num(row.expert_net_members);
      bucket.sessions += -num(row.expert_net_monthly_hours);
      priorCredit.set(key, bucket);
    }
  }
  return rows.map((row) => {
    const key = `${row.attribution_id}|${row.manager_id}`;
    const win = byJournal.get(key) || { members: 0, sessions: 0 };
    const credit = priorCredit.get(key) || { members: 0, sessions: 0 };
    return {
      ...row,
      lifetime_members: win.members + credit.members,
      lifetime_sessions: win.sessions + credit.sessions,
    };
  });
}

function tiles(rows) {
  const { rows: netted, suppressed } = netLedgerJournal(rows, displayByEmail, new Set());
  const out = { members: 0, sessions: 0, cancelMembers: 0, cancelSessions: 0 };
  for (const row of netted) {
    out.members += row.members;
    out.sessions += row.sessions;
    if (row.kind === "cancel") {
      out.cancelMembers += Math.min(row.members, 0);
      out.cancelSessions += Math.min(row.sessions, 0);
    }
  }
  out.dropped = suppressed.filter((s) => s.reason === "duplicate-period-line").length;
  return out;
}

const cleanRows = exportRows.map((entry) => toLedgerRow(entry));

const n = (v) => v.toFixed(2).padStart(9);
console.log(`${exportRows.length} roster lines from the export, ${siblings} prior-month cancels rebuilt with their sibling line`);
console.log();
console.log(`export sums (raw negatives) members ${n(exportTotals.members)}  cancels ${n(exportTotals.cancelMembers)} ${n(exportTotals.cancelSessions)}`);

// Control: the export's lines alone, through the shipped pipeline. Cancels sit
// 1 member / 8 sessions inside the raw negative sum because one re-book
// (Chris Jones, client 8566758: +1/8, -1/-8, +1/4) is a correction, not lost
// business. That is the number the tiles should show.
const baseline = tiles(withLifetime(cleanRows, { includeOriginalCredit: true }));
console.log(`control: export only       members ${n(baseline.members)}  cancels ${n(baseline.cancelMembers)} ${n(baseline.cancelSessions)}`);

// 1. Duplicated shape, no lifetime totals -> the bug on the dashboard today.
const broken = tiles(ledgerRows);
console.log(`without lifetime check     members ${n(broken.members)}  cancels ${n(broken.cancelMembers)} ${n(broken.cancelSessions)}`);

// 2. Duplicated shape, lifetime totals -> identical to the control.
const fixed = tiles(withLifetime(ledgerRows, { includeOriginalCredit: true }));
console.log(`with lifetime check        members ${n(fixed.members)}  cancels ${n(fixed.cancelMembers)} ${n(fixed.cancelSessions)}  (${fixed.dropped} duplicate lines dropped)`);
console.log();

// The reproduction has to look like what the dashboard shows, or this is the
// wrong shape and the fix is aimed at the wrong thing.
assert.ok(
  broken.cancelMembers < baseline.cancelMembers - 30,
  `expected the duplicated shape to overshoot by ~36 members, got ${broken.cancelMembers}`
);
assert.ok(
  broken.members < baseline.members - 30,
  "and to drag MTD members down by the same lines"
);

// The fix has to be exact, not close: duplicated input must produce byte-equal
// tiles to clean input.
assert.equal(fixed.cancelMembers, baseline.cancelMembers, "cancel members must match the export-only control");
assert.equal(fixed.cancelSessions, baseline.cancelSessions, "cancel sessions must match the export-only control");
assert.equal(fixed.members, baseline.members, "MTD members must match the export-only control");
assert.equal(fixed.sessions, baseline.sessions, "MTD sessions must match the export-only control");
assert.equal(fixed.dropped, siblings, "every rebuilt sibling line is dropped, and only those");
assert.equal(baseline.dropped, 0, "nothing is dropped when the ledger has no duplicates");

// And the control itself must sit within the one known re-book of the export.
assert.ok(
  Math.abs(baseline.cancelMembers - exportTotals.cancelMembers) <= 1,
  "control stays within the single re-book of the export's raw negatives"
);
assert.equal(Number(baseline.members.toFixed(2)), Number(exportTotals.members.toFixed(2)), "members match the export exactly");

console.log("ok — duplicated shape reproduces the wrong tile; the lifetime check restores export parity exactly");
