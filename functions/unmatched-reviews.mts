import {getStore} from '@netlify/blobs';
import type {Context} from '@netlify/functions';
import {requireSignedIn} from './_shared/identity.mts';
import {requireAdmin} from './_shared/access.mts';
import {liveMonth,liveStore,liveRoster,rosterAliases} from './_shared/starburst-live.mts';
import {loadLedgerExclusionIds} from './_shared/ledger-exclusions.mts';
import {reviewStore,fingerprint,applyReviews,validateDecision,pacerClientCheck} from './_shared/unmatched-reviews.mts';
const json=(data:any,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
export default async(req:Request,context:Context)=>{
 try {
  const auth=await requireSignedIn(req,context);if(auth.response)return auth.response;
  const denied=await requireAdmin(auth.user);if(denied)return denied;
  if(!['GET','POST'].includes(req.method))return json({error:'Method not allowed'},405);
  let month;try{month=liveMonth(new URL(req.url).searchParams.get('month'));}catch{return json({error:'Invalid month'},400);}
  const snapshot=await liveStore().get(`month:${month}`,{type:'json'}) as any;
  if(!snapshot)return json({error:'No Starburst snapshot is available for this month yet.'},503);
  const roster=await liveRoster(),aliases=rosterAliases(roster),belongs=(r:any)=>!!aliases[String(r.manager||'').trim().toLowerCase()];
  const store=reviewStore(),saved=await store.getWithMetadata(month,{type:'json'}),doc:any=saved?.data||{decisions:{},history:[]};
  if(req.method==='GET') {
   const applied=applyReviews(snapshot,doc.decisions);
   const excluded=await loadLedgerExclusionIds();
   const manualStore=getStore('manual-attributions');
   const {blobs}=await manualStore.list();
   const manuals=(await Promise.all(blobs.map(b=>manualStore.get(b.key,{type:'json'})))).filter(Boolean);
   const check=(r:any)=>pacerClientCheck(r,applied.rows,manuals,aliases,roster,excluded,month);
   const effect=(d:any)=>excluded.has(d.ledgerId)?'Excluded by the separate ledger-exclusion list.':d.action==='reopen'?'Reopened':(snapshot.rows||[]).some((r:any)=>String(r.ledger_id)===d.ledgerId)?(d.action==='deny'?'Excluded even though the source now matches.':'Source now matches automatically; approval is not added again.'):applied.approved.some(r=>String(r.ledgerId)===d.ledgerId)?'Included in pacer totals.':applied.denied.some(r=>String(r.ledgerId)===d.ledgerId)?'Excluded from pacer totals.':applied.pending.some(r=>String(r.ledgerId)===d.ledgerId)?'Source changed — awaiting a new review.':'No longer present or superseded; not added to totals.';
   return json({month,fetchedAt:snapshot.fetchedAt,sourceUpdatedAt:snapshot.sourceUpdatedAt,pending:applied.pending.filter(belongs).map(r=>({...r,rep:roster[aliases[String(r.manager).trim().toLowerCase()]],pacerCheck:check(r)})),decisions:Object.values(doc.decisions).filter((d:any)=>belongs(d.record)).map((d:any)=>({...d,effect:effect(d),pacerCheck:check(d.record)})),history:doc.history.filter((d:any)=>belongs(d.record)).slice(-300).reverse()});
  }
  let body,decision;try{body=await req.json();decision=validateDecision(body);}catch(e){return json({error:e instanceof Error?e.message:'Invalid request'},400);}
  const id=String(body.ledgerId),old=doc.decisions[id];
  if(String(body.expectedAt||'')!==String(old?.at||''))return json({error:'Another admin changed this record. Reload and review the latest decision.'},409);
  const record=(snapshot.unresolved||[]).find((r:any)=>String(r.ledgerId)===id&&belongs(r));
  if(decision.action!=='reopen'&&(!record||body.fingerprint!==fingerprint(record)))return json({error:'This record changed or was matched automatically. Reload the queue.'},409);
  if(decision.action==='reopen'&&(!old||!belongs(old.record)))return json({error:'Reviewed record not found'},404);
  const next={...decision,ledgerId:id,record:record||old.record,fingerprint:record?fingerprint(record):old.fingerprint,by:auth.user.email,at:new Date().toISOString()};
  const updated={decisions:{...doc.decisions,[id]:next},history:[...doc.history,next]};
  const result=await store.setJSON(month,updated,saved?.etag?{onlyIfMatch:saved.etag}:{onlyIfNew:true});
  if(!result.modified)return json({error:'Another review was saved at the same time. Reload and retry.'},409);
  return json({ok:true,decision:next});
 }catch{return json({error:'Review service unavailable. No decision was confirmed; reload before retrying.'},503);}
};
export const config={path:'/api/starburst/reviews'};
