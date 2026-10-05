import {getStore} from '@netlify/blobs';
/** Private, site-scoped business exceptions must never be embedded in public source. */
export async function loadReviewedLedgerRules() {
  const rules=await getStore({name:'private-starburst-ledger-rules',consistency:'strong'}).get('reviewed-v1',{type:'json'}) as any;
  return validateReviewedLedgerRules(rules);
}
export function validateReviewedLedgerRules(rules:any) {
  if(rules?.schemaVersion!==1 || !rules.reviewedLedgers || typeof rules.reviewedLedgers!=='object' || Array.isArray(rules.reviewedLedgers) || !Array.isArray(rules.excludedLedgerIds) || typeof rules.reviewedAt!=='string') throw new Error('Private ledger rules are unavailable');
  for(const [id,v] of Object.entries(rules.reviewedLedgers) as any) {
    if(!/^\d+$/.test(id) || !v || !['clientId','attributionId','managerId','sourceDate','date'].every(k=>typeof v[k]==='string' && v[k]) || !['amountCents','members','sessions'].every(k=>typeof v[k]==='number' && Number.isFinite(v[k]))) throw new Error('Private ledger rules are invalid');
  }
  if(!rules.excludedLedgerIds.every((id:any)=>typeof id==='string' && /^\d+$/.test(id))) throw new Error('Private ledger rules are invalid');
  return rules;
}
export function reviewedLedgerRow(r:any, rules:any) {
  const v=rules.reviewedLedgers[String(r.ledgerId)];
  if (!v) return null;
  if (String(r.clientId)!==v.clientId || String(r.attributionId)!==v.attributionId || String(r.managerId)!==v.managerId || r.date!==v.sourceDate || Math.abs(Number(r.amountCents)-v.amountCents)>=1) return null;
  return {email:'',manager_name:r.manager,manager_id:String(r.managerId),client_id:String(r.clientId),ledger_id:String(r.ledgerId),attribution_id:String(r.attributionId),credit_id:r.creditId==null?null:String(r.creditId),attribution_date:v.date,occurred_at:v.date,ledger_created_at:r.capturedAt,members:v.members,sessions:v.sessions,kind:v.members<0?'cancel':'credit',provisional:false,reviewed:true,reviewedAt:rules.reviewedAt,reviewSource:'Privately stored verified ledger correction'};
}
