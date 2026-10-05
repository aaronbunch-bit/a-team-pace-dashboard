import {loadReviewedLedgerRules} from './_shared/starburst-reviewed-ledgers.mts';
import { randomUUID } from 'node:crypto';
import { accessToken, queryStarburst } from './_shared/starburst-oauth.mts';
import { allowed, connectionStore, setting } from './_shared/starburst-connection-test.mts';
import { liveMonth, liveStore, liveRoster, rosterAliases, liveEnabled, refreshDue, refreshRetryDelay } from './_shared/starburst-live.mts';
import { liveQuery } from './_shared/starburst-live-query.mts';
import { parseLiveResult, reconstruct, inheritRefundMembership, parentMembershipQuery } from './_shared/starburst-reconstruction.mts';
export default async (req: Request) => {
  if (req.method !== 'POST' || !allowed(req) || !liveEnabled()) return;
  let month: string;
  try { month = liveMonth(new URL(req.url).searchParams.get('month')); } catch { return; }
  const store=liveStore(), key=`month:${month}`, now=Date.now();
  const previous=await store.get(key,{type:'json'}) as any;
  const previousStatus=await store.get(`status:${month}`,{type:'json'}) as any;
  if (!refreshDue(previous,previousStatus,now)) return;
  // One account-wide lease keeps background workers from competing for token renewal.
  const lock=await store.getWithMetadata('refresh-lock',{type:'json'});
  if (lock?.data?.state==='running' && now-lock.data.startedAtMs < 840000) return;
  const runId=randomUUID();
  const claim=await store.setJSON('refresh-lock',{state:'running',runId,startedAtMs:now,month},lock?.etag?{onlyIfMatch:lock.etag}:{onlyIfNew:true});
  if (!claim.modified || !claim.etag) return;
  await store.setJSON(`status:${month}`,{state:'running',startedAtMs:now,failures:previousStatus?.failures||0});
  try {
    const roster=await liveRoster();
    const token=await accessToken(connectionStore() as any,setting('STARBURST_TOKEN_ENCRYPTION_KEY'),setting('STARBURST_OAUTH_SEED'));
    const names=Object.keys(rosterAliases(roster)), asOf=new Date(now).toISOString();
    const records:any[]=[], queryIds:string[]=[];
    let total=0;
    let sourceUpdatedAt: string | null=null;
    for(let page=0;page<=200;page++) {
      if(Date.now()-now>720000) throw new Error('Refresh time limit');
      const data=await queryStarburst(token,liveQuery(month,names,page,asOf));
      const part=parseLiveResult(data);
      if(page===0) {
        const sourceIndex=data.columns.findIndex((c:any)=>c.columnName==='source_updated_at');
        const value=sourceIndex>=0 ? data.rows[0]?.[sourceIndex] : null;
        sourceUpdatedAt=value && value!=='null' ? String(value) : null;
      }
      const totalIndex=data.columns.findIndex((c:any)=>c.columnName==='total_count');
      const reported=Number(data.rows[0][totalIndex]);
      if(!Number.isInteger(reported) || reported<0 || reported>20000 || (page>0 && reported!==total)) throw new Error('Incomplete snapshot');
      total=reported; records.push(...part); queryIds.push(data.queryId);
      if(records.length===total) break;
      if(!part.length || records.length>total) throw new Error('Incomplete snapshot');
    }
    if(records.length!==total) throw new Error('Incomplete snapshot');
    let classified=inheritRefundMembership(records);
    const parentIds=[...new Set(classified.filter(r=>r.paymentMethod==='Refund' && r.membershipFlag==null && r.parentCreditId).map(r=>String(r.parentCreditId)))];
    const parents:Record<string,number>={};
    for(let start=0;start<parentIds.length;start+=300) {
      const parentData=await queryStarburst(token,parentMembershipQuery(parentIds.slice(start,start+300)));
      const flags=JSON.parse(parentData.rows[0][0] || 'null');
      if(flags) Object.assign(parents,flags);
      queryIds.push(parentData.queryId);
    }
    classified=inheritRefundMembership(classified,parents);
    const result=reconstruct(classified,await loadReviewedLedgerRules());
    const fetchedAtMs=Date.now();
    await store.setJSON(key,{...result,rawRowCount:records.length,queryId:queryIds.at(-1),queryIds,month,fetchedAtMs,
      fetchedAt:new Date(fetchedAtMs).toISOString(),sourceWatermarkVersion:1,sourceUpdatedAt,teamSourceUpdatedAt:records.map(r=>String(r.capturedAt||'')).sort().at(-1)||null});
    await store.setJSON(`status:${month}`,{state:'succeeded',checkedAt:new Date().toISOString(),queryId:queryIds.at(-1),queryIds});
  } catch (error) {
    // These transport errors are generated locally and contain no tokens or query data.
    const detail = error instanceof Error ? error.message : '';
    const safe = /^(Starburst (renewal|credential|encryption|connection|purchases connection|response|read-only query|query result)|Incomplete snapshot|Refresh time limit)/.test(detail) ? detail : 'Starburst refresh failed';
    console.error('Starburst refresh failed', {month, reason:safe});
    const failures=(Number(previousStatus?.failures)||0)+1;
    await store.setJSON(`status:${month}`,{state:'failed',checkedAt:new Date().toISOString(),message:safe,failures,nextRetryAtMs:Date.now()+refreshRetryDelay(failures)});
  } finally {
    await store.setJSON('refresh-lock',{state:'idle',runId,month},{onlyIfMatch:claim.etag});
  }
};
