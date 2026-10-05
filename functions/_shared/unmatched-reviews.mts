import { expandTransfers } from "./attribution-transfer.mts";
import {createHash} from 'node:crypto';
import {getStore} from '@netlify/blobs';
export const reviewStore = () => getStore({name:'starburst-admin-reviews-v1',consistency:'strong'});
export function fingerprint(r:any) {
  return createHash('sha256').update(JSON.stringify([String(r.ledgerId),String(r.clientId),r.manager,r.date,r.reason,r.evidence||null])).digest('hex');
}
export function sameRecord(d:any,r:any) {return String(d.record.clientId)===String(r.clientId)&&d.record.manager===r.manager&&d.record.date===r.date;}
export function applyReviews(snapshot:any, decisions:Record<string,any>) {
  const rows=[...(snapshot.rows||[])], pending:any[]=[], approved:any[]=[], denied:any[]=[];
  const automatic=new Set(rows.map(r=>String(r.ledger_id))), superseded=new Set(snapshot.superseded||[]);
  const deniedIds=new Set<string>(),seen=new Set<string>();
  for(const [id,d] of Object.entries(decisions)) if(d.action==='deny') {
    const r=rows.find(r=>String(r.ledger_id)===id);
    if(r&&sameRecord(d,{clientId:r.client_id,manager:r.manager_name,date:r.attribution_date}))deniedIds.add(id);
  }
  for(const r of snapshot.unresolved||[]) {
    const id=String(r.ledgerId),d=decisions[id];
    if(seen.has(id))continue;seen.add(id);
    if(automatic.has(id)||superseded.has(id))continue;
    if(d&&sameRecord(d,r)&&d.action==='deny'){denied.push(r);deniedIds.add(id);continue;}
    if(d?.action==='approve'&&sameRecord(d,r)&&d.fingerprint===fingerprint(r)) {
      rows.push({email:'',manager_name:r.manager,manager_id:r.managerId||'',client_id:r.clientId,ledger_id:id,attribution_id:r.attributionId||'',credit_id:null,attribution_date:r.date,occurred_at:r.date,members:d.members,sessions:d.sessions,kind:d.members<0||d.sessions<0?'cancel':'credit',provisional:false,reviewed:true,reviewedAt:d.at,reviewSource:'Admin unmatched-record review'});
      approved.push(r);continue;
    }
    pending.push({...r,reviewFingerprint:fingerprint(r),previousDecision:d?.action==='approve'?'Source changed — please review again':undefined});
  }
  return {rows:rows.filter(r=>!deniedIds.has(String(r.ledger_id))),pending,approved,denied};
}
export function validateDecision(body:any) {
  if(!['approve','deny','reopen'].includes(body?.action))throw Error('Choose approve, deny, or reopen.');
  if(!/^(?:\d{1,24}|combined:\d{1,24}:\d{1,24})$/.test(String(body.ledgerId||'')))throw Error('Invalid record identifier.');
  const note=String(body.note||'').trim();if(!note||note.length>2000)throw Error('Enter a review note (up to 2,000 characters).');
  if(body.action==='approve') {
    for(const key of ['members','sessions'])if(body[key]===null||body[key]===undefined||String(body[key]).trim()===''||!Number.isFinite(Number(body[key])))throw Error('Enter verified member and session amounts, including zero when applicable.');
    const m=Number(body.members),s=Number(body.sessions);
    if(Math.abs(m)>100||Math.abs(s)>10000||m*s<0)throw Error('Check the signed member and session amounts. Refunds must use negative amounts.');
  }
  return {action:body.action,note,...(body.action==='approve'?{members:Number(body.members),sessions:Number(body.sessions)}:{})};
}

/** Same rep, client and month as the individual pacer's included ledger/manual entries. */
export function pacerClientCheck(record:any, rows:any[], manuals:any[], aliases:Record<string,string>, roster:Record<string,string>, excluded:Set<string>, month:string) {
  const repEmail=aliases[String(record.manager||'').trim().toLowerCase()];
  const rep=roster[repEmail],client=String(record.clientId||'').trim();
  const entries:any[]=[],manualRequests:any[]=[];
  for(const row of rows) {
    if(aliases[String(row.manager_name||'').trim().toLowerCase()]!==repEmail||!repEmail||String(row.client_id)!==client||String(row.attribution_date).slice(0,7)!==month||excluded.has(String(row.ledger_id)))continue;
    entries.push({source:row.reviewSource==='Admin unmatched-record review'?'Admin-approved unmatched record':'Starburst',id:String(row.ledger_id),date:row.attribution_date,members:row.members,sessions:row.sessions});
  }
  let unidentifiedManualEntries=0;
  for(const r of expandTransfers(manuals)) {
    if(r.repName!==rep||String(r.saleDate||'').slice(0,7)!==month)continue;
    let id=/^\d+$/.test(String(r.clientId||'').trim())?String(r.clientId).trim():'';
    if(!id)try {const url=new URL(String(r.clientLink||''));id=url.pathname.match(/\/clients\/(\d+)(?:\/|$)/)?.[1]||'';}catch{/* Unidentifiable manual entries must not become false negatives. */}
    if(!id){if(r.status==='approved')unidentifiedManualEntries++;continue;}
    if(id===client&&r.status!=='approved'){manualRequests.push({id:String(r.id||''),status:r.status,date:r.saleDate,members:r.members,sessions:r.sessions});continue;}
    if(id===client)entries.push({source:'Approved manual attribution',id:String(r.id||''),date:r.saleDate,members:r.members,sessions:r.sessions});
  }
  return {rep,month,found:entries.length>0,entries,manualRequests,unidentifiedManualEntries,members:entries.reduce((n,r)=>n+Number(r.members||0),0),sessions:entries.reduce((n,r)=>n+Number(r.sessions||0),0)};
}
