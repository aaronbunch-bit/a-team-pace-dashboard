/**
 * Replay a rep-scores ledger export through the pacer's own netting code and
 * print what the tiles would read.
 *
 * Run: node --experimental-strip-types scripts/replay-rep-scores-export.mjs <export.csv>
 *
 * This is the parity check: the export is what reps reconcile against, so if
 * these totals match the export's own sums and the manual pacer's refunds, the
 * only thing left that can differ live is the month window in the SQL.
 *
 * Expected columns are the export's own headers (manager, client_id,
 * attribution_date, expert_net_members, expert_net_monthly_hours,
 * attribution_id, ledger_id, conference_id_timestamps).
 */
import { readFileSync } from "node:fs";
import { netLedgerJournal } from "../functions/get-live-actuals.mts";
import { FALLBACK_ROSTER_EMAILS } from "../functions/_shared/roster.mts";

const csvPath = process.argv[2];
if (!csvPath) {
  console.error("usage: node --experimental-strip-types scripts/replay-rep-scores-export.mjs <export.csv>");
  process.exit(2);
}

/** Minimal RFC4180 reader — the export quotes comments containing commas. */
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

// The export writes a rep's name however Flex has it — match on a squashed form
// so "JENNA SALUPO" and "Christopher Jones" still land on the roster.
const squash = (name) => String(name || "").toLowerCase().replace(/[^a-z]/g, "");
const emailByName = new Map();
for (const [email, display] of Object.entries(FALLBACK_ROSTER_EMAILS)) {
  emailByName.set(squash(display), email);
  emailByName.set(squash(email.split("@")[0].replace(/[._]/g, " ")), email);
}
const displayByEmail = Object.fromEntries(
  Object.entries(FALLBACK_ROSTER_EMAILS).map(([email, display]) => [email, display])
);

const rows = readCsv(readFileSync(csvPath, "utf8"))
  .map((r) => ({ row: r, email: emailByName.get(squash(r.manager)) }))
  .filter((r) => r.email)
  .map(({ row, email }) => ({
    email,
    manager_name: row.manager,
    client_id: row.client_id,
    attribution_date: String(row.attribution_date || "").slice(0, 10),
    occurred_at: row.attribution_date,
    sale_occurred_at: String(row.conference_id_timestamps || "").slice(0, 19),
    members: Number(row.expert_net_members || 0),
    sessions: Number(row.expert_net_monthly_hours || 0),
    ledger_id: row.ledger_id,
    attribution_id: row.attribution_id,
    manager_id: row.manager_id,
    // The export has no write timestamp per line; its business date orders the
    // journal well enough to tell a revision from a cancel.
    ledger_created_at: row.attribution_date,
  }));

const raw = rows.reduce(
  (acc, r) => ({
    members: acc.members + r.members,
    sessions: acc.sessions + r.sessions,
    negMembers: acc.negMembers + Math.min(r.members, 0),
    negSessions: acc.negSessions + Math.min(r.sessions, 0),
  }),
  { members: 0, sessions: 0, negMembers: 0, negSessions: 0 }
);

const netted = netLedgerJournal(rows, displayByEmail, new Set()).rows;
const perRep = {};
const team = { members: 0, sessions: 0, cancelMembers: 0, cancelSessions: 0 };
for (const row of netted) {
  const name = displayByEmail[row.email] || row.manager_name;
  const bucket = (perRep[name] ||= { members: 0, sessions: 0, cancelMembers: 0, cancelSessions: 0 });
  bucket.members += row.members;
  bucket.sessions += row.sessions;
  team.members += row.members;
  team.sessions += row.sessions;
  if (row.kind === "cancel") {
    if (row.members < 0) { bucket.cancelMembers += row.members; team.cancelMembers += row.members; }
    if (row.sessions < 0) { bucket.cancelSessions += row.sessions; team.cancelSessions += row.sessions; }
  }
}

const n = (v) => v.toFixed(2).padStart(9);
console.log(`${csvPath} — ${rows.length} roster ledger lines`);
console.log(`export sums    members ${n(raw.members)}  sessions ${n(raw.sessions)}  negatives ${n(raw.negMembers)} ${n(raw.negSessions)}`);
console.log(`pacer would show members ${n(team.members)}  sessions ${n(team.sessions)}  cancels   ${n(team.cancelMembers)} ${n(team.cancelSessions)}`);
console.log();
for (const [name, v] of Object.entries(perRep).sort(([a], [b]) => a.localeCompare(b))) {
  console.log(`${name.padEnd(22)} members ${n(v.members)}  sessions ${n(v.sessions)}  cancels ${n(v.cancelMembers)} ${n(v.cancelSessions)}`);
}
