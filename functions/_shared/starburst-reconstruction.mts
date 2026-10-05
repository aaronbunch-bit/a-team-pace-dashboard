import {reviewedLedgerRow} from './starburst-reviewed-ledgers.mts';
/** Provisional reconstruction from exported attribution amounts and uniquely matched purchases. */
export function reconstruct(records: any[], rules:any = {reviewedLedgers:{},excludedLedgerIds:[]}) {
  const unresolved: any[] = [], superseded: string[] = [], rows: any[] = [];
  const byEntry = new Map<string, any[]>();
  const flag = (r: any, reason: string, evidence:any[]=[r]) => unresolved.push({ ledgerId: String(r.ledgerId || r.id), manager: r.manager, clientId: String(r.clientId), date: r.date, reason, managerId:String(r.managerId||''), attributionId:String(r.attributionId||''), amountCents:r.amountCents, evidence:evidence.map(x=>[x.attributionId,x.managerId,x.amountCents,x.creditId,x.creditCents,x.hours,x.membershipFlag,x.paymentMethod]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))) });
  for (const r of records) {
    const key = String(r.ledgerId || `missing:${r.id}`);
    const list = byEntry.get(key) || []; list.push(r); byEntry.set(key, list);
  }
  const purchases = new Map<string, any[]>();
  for (const versions of byEntry.values()) {
    const latest = versions.reduce((a, b) => newer(a, b) ? a : b);
    if (rules.excludedLedgerIds.includes(String(latest.ledgerId))) continue;
    const reviewed = reviewedLedgerRow(latest,rules);
    if (reviewed) { rows.push(reviewed); continue; }
    const candidates = versions.filter(r => String(r.id) === String(latest.id));
    const matches = new Map(candidates.filter(r => r.creditId != null).map(r => [String(r.creditId), r]));
    if (!latest.ledgerId || matches.size !== 1) { flag(latest, matches.size > 1 ? 'Ambiguous purchase match' : 'No purchase match',candidates); continue; }
    const r = [...matches.values()][0];
    const key = String(r.creditId), list = purchases.get(key) || []; list.push(r); purchases.set(key, list);
  }
  for (const list of purchases.values()) {
    const latestTime = list.map(r => String(r.capturedAt || '')).sort().at(-1);
    const active = list.filter(r => String(r.capturedAt || '') === latestTime);
    superseded.push(...list.filter(r => !active.includes(r)).map(r => String(r.ledgerId)));
    const reps = new Map<string, any>();
    for (const r of active) {
      const previous = reps.get(String(r.managerId));
      if (!previous || newer(r, previous)) reps.set(String(r.managerId), r);
    }
    const current = [...reps.values()];
    // Match the credited amount within $1, then use exact full/half credit.
    // Never turn rounding noise into fractional members or hours.
    const fractions = current.map(r => {
      const amount = Number(r.amountCents), purchase = Number(r.creditCents);
      if (!Number.isFinite(amount) || !Number.isFinite(purchase) || amount === 0 || Math.sign(amount) !== Math.sign(purchase)) return NaN;
      const matches = [0.5, 1].filter(f => Math.abs(amount - purchase * f) < 100);
      return matches.length === 1 ? matches[0] : NaN;
    });
    const invalid = current.some((r, i) => !r.managerId || !Number.isFinite(Number(r.hours)) || !Number.isFinite(fractions[i]) || ![0,1].includes(r.membershipFlag) || ![0.5,1].some(f => Math.abs(f - fractions[i]) < 0.000001));
    const total = fractions.reduce((a, b) => a + b, 0);
    if (invalid || Math.abs(total - 1) > 0.000001 || new Set(current.map(r => String(r.attributionId))).size > 1) {
      current.forEach(r => flag(r, 'Allocation or membership classification needs review')); continue;
    }
    for (let i = 0; i < current.length; i++) {
      const r = current[i], refund = Number(r.creditCents) < 0;
      if ((refund && r.paymentMethod !== 'Refund') || /transfer|adjustment/i.test(r.paymentMethod || '')) { flag(r, 'Transfer or adjustment needs review'); continue; }
      rows.push({ email: '', manager_name: r.manager, manager_id: String(r.managerId), client_id: String(r.clientId),
        ledger_id: String(r.ledgerId), attribution_id: String(r.attributionId), credit_id: String(r.creditId),
        attribution_date: r.date, occurred_at: r.date, ledger_created_at: r.capturedAt,
        members: r.membershipFlag * fractions[i] * (refund ? -1 : 1),
        sessions: Math.round(Number(r.hours) * fractions[i] * 100) / 100,
        kind: refund ? 'cancel' : 'credit', provisional: true });
    }
  }
  return { rows, unresolved, superseded, rule: 'latest-purchase-allocation-v1' };
}
function newer(a: any, b: any) {
  const at = String(a.capturedAt || ''), bt = String(b.capturedAt || '');
  return at === bt ? BigInt(a.id) > BigInt(b.id) : at > bt;
}
export function parseLiveResult(data: any) {
  const countIndex = data.columns?.findIndex((c: any) => c.columnName === 'row_count');
  const recordsIndex = data.columns?.findIndex((c: any) => c.columnName === 'records');
  if (data.rows?.length !== 1 || !(countIndex >= 0) || !(recordsIndex >= 0)) throw new Error('Invalid query result');
  const count = Number(data.rows[0][countIndex]);
  if (!Number.isInteger(count) || count < 0 || count > 20000) throw new Error('Query result exceeds the supported limit');
  const records = count === 0 ? [] : JSON.parse(data.rows[0][recordsIndex]);
  if (!Array.isArray(records) || records.length !== count) throw new Error('Incomplete query result');
  const keys = ["id","ledgerId","attributionId","clientId","manager","managerId","date","capturedAt","amountCents","creditId","creditCents","hours","membershipFlag","paymentMethod","parentCreditId","creditUpdatedAt"];
  return records.map(row => Object.fromEntries(keys.map((key,index) => {
    const value = Array.isArray(row) ? row[index] ?? null : row[key] ?? row[key.toLowerCase()] ?? null;
    return [key, value !== null && ["amountCents","creditCents","hours","membershipFlag"].includes(key) ? Number(value) : value];
  })));
}

export function inheritRefundMembership(records:any[], parents:Record<string,number>={}) {
  const flags = {...parents};
  for(const r of records) if(r.creditId && [0,1].includes(r.membershipFlag)) flags[String(r.creditId)]=r.membershipFlag;
  return records.map(r=>r.paymentMethod==='Refund' && r.membershipFlag==null && r.parentCreditId && flags[String(r.parentCreditId)]!==undefined ? {...r,membershipFlag:flags[String(r.parentCreditId)]} : r);
}
export function parentMembershipQuery(ids:string[]) {
  if(!ids.length || ids.length>300 || ids.some(id=>!/^\d{1,10}$/.test(id))) throw new Error('Invalid parent credit identifiers');
  return `SELECT json_format(CAST(map_agg(CAST(id AS varchar),1) AS JSON)) flags FROM raw_redshift.vtwa.credits WHERE id IN (${ids.join(',')}) AND payment_category='1:1 Memberships'`;
}
