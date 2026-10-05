/** Purchase-keyed, explicitly provisional supplement. Never replaces an exported allocation. */
export function combinedQuery(month:string,names:string[],page=0,asOf=new Date().toISOString()) {
  if(!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month) || !names.length || names.length>200 || !Number.isInteger(page) || page<0 || page>200 || !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(asOf)) throw new Error('Invalid combined query scope');
  const scope=names.map(n=>`'${n.trim().toLowerCase().replace(/'/g,"''")}'`).join(',');
  return `WITH period AS (
    SELECT with_timezone(TIMESTAMP '${month}-01 00:00:00','America/Chicago') lo,
      with_timezone(TIMESTAMP '${month}-01 00:00:00'+INTERVAL '1' MONTH,'America/Chicago') hi,
      from_iso8601_timestamp('${asOf}') as_of
  ), credits AS (
    SELECT c.id,c.client_id,c.created_at,c.updated_at,c.payment_method,c.parent_credit_id,
      CAST(c.payment_amount AS double) cents,CAST(c.duration AS double)/3600 hours,c.payment_category
    FROM raw_redshift.vtwa.credits c CROSS JOIN period t
    WHERE c.created_at>=CAST(at_timezone(t.lo,'UTC') AS timestamp)-INTERVAL '67' DAY
      AND c.created_at<CAST(at_timezone(least(t.hi,t.as_of),'UTC') AS timestamp)
      AND c.payment_method IN ('Web Site','Internal Terminal','Refund')
  ), purchases AS (
    SELECT c.*,coalesce(parent.created_at,c.created_at) sale_at,
      CAST(at_timezone(with_timezone(c.created_at,'UTC'),'America/Chicago') AS date) day,
      CAST(at_timezone(with_timezone(coalesce(parent.created_at,c.created_at),'UTC'),'America/Chicago') AS date) sale_day,
      coalesce(parent.payment_category,c.payment_category) category,
      (SELECT count(*) FROM credits prev WHERE prev.client_id=c.client_id AND prev.id<>c.id
        AND prev.payment_method IN ('Web Site','Internal Terminal')
        AND abs(date_diff('second',prev.created_at,c.created_at))<86400) adjacent_sales
    FROM credits c CROSS JOIN period t LEFT JOIN credits parent ON parent.id=c.parent_credit_id
    WHERE c.created_at>=CAST(at_timezone(t.lo,'UTC') AS timestamp)
  ), calls AS (
    SELECT m.call_sid,m.lead_id,m.manager_id,m.started_at,cp.participant_id,
      cp.mgr_name,upper(cp.call_participant_type) role,cp.call_duration_manager seconds,
      cp._ingested_at loaded_at
    FROM silver.calls.slv_manager_call_attribution m
    JOIN silver.calls.slv_call_participants cp ON cp.call_sid=m.call_sid AND cp.participant_id=m.participant_id
    CROSS JOIN period t
    WHERE m.started_date>=DATE '${month}-01'-INTERVAL '74' DAY
      AND m.started_date<DATE '${month}-01'+INTERVAL '1' MONTH
      AND cp.started_date>=DATE '${month}-01'-INTERVAL '74' DAY
      AND cp.started_date<DATE '${month}-01'+INTERVAL '1' MONTH
      AND m.started_at<t.as_of AND m.participant_type='manager'
  ), links AS (
    SELECT p.id,k lead_id FROM purchases p JOIN silver.leads.slv_lead_all l ON l.client_id=p.client_id
      CROSS JOIN UNNEST(ARRAY[l.lead_id,l.contact_historical_key]) u(k) WHERE k IS NOT NULL
    UNION
    SELECT p.id,c.lead_id FROM purchases p
      JOIN raw_sb_acquisition_analytics.public.pgc_numerator_credits pg ON pg.vt_credit_id=coalesce(p.parent_credit_id,p.id)
      JOIN calls c ON c.call_sid=pg.winning_call_sid WHERE c.lead_id IS NOT NULL
  ), candidates AS (
    SELECT DISTINCT p.id,c.call_sid,c.manager_id,c.mgr_name,c.role,c.seconds,c.started_at,c.participant_id
    FROM purchases p JOIN links l ON l.id=p.id JOIN calls c ON c.lead_id=l.lead_id
    WHERE c.started_at>=with_timezone(CAST(p.sale_day-INTERVAL '7' DAY AS timestamp),'America/Chicago')
      AND c.started_at<=with_timezone(p.sale_at,'UTC')
  ), scoped AS (
    SELECT p.*, (SELECT max(prev.created_at) FROM credits prev WHERE prev.client_id=p.client_id
      AND prev.payment_method IN ('Web Site','Internal Terminal') AND prev.created_at<p.sale_at-INTERVAL '24' HOUR) previous_sale
    FROM purchases p WHERE p.id IN (SELECT id FROM candidates WHERE lower(trim(mgr_name)) IN (${scope}))
  ), grouped AS (
    SELECT p.id,p.client_id,p.day,p.cents,p.hours,p.category,p.payment_method,p.parent_credit_id,p.adjacent_sales,
      json_format(CAST(array_agg(ARRAY[c.manager_id,c.mgr_name,c.role,CAST(c.seconds AS varchar),CAST(c.started_at AS varchar),c.call_sid,CAST(c.participant_id AS varchar)] ORDER BY c.started_at,c.call_sid,c.participant_id) AS JSON)) calls
    FROM scoped p JOIN candidates c ON c.id=p.id
    WHERE p.previous_sale IS NULL OR c.started_at>=with_timezone(p.previous_sale,'UTC')
    GROUP BY 1,2,3,4,5,6,7,8,9
  ), limited AS (SELECT *,count(*) OVER() total_count FROM grouped ORDER BY id OFFSET ${page*200} LIMIT 200)
  SELECT count(*) row_count,coalesce(max(total_count),0) total_count,
    (SELECT CAST(max(loaded_at) AS varchar) FROM calls) calls_updated_at,
    (SELECT CAST(with_timezone(max(updated_at),'UTC') AS varchar) FROM credits) purchases_updated_at,
    (SELECT CAST(max(matched_at) AS varchar) FROM raw_sb_acquisition_analytics.public.pgc_numerator_credits WHERE matched_at<=from_iso8601_timestamp('${asOf}')) matches_updated_at,
    json_format(CAST(array_agg(ARRAY[CAST(id AS varchar),CAST(client_id AS varchar),CAST(day AS varchar),CAST(cents AS varchar),CAST(hours AS varchar),category,payment_method,CAST(parent_credit_id AS varchar),CAST(adjacent_sales AS varchar),calls]) AS JSON)) records
    FROM limited`;
}

export function parseCombinedResult(data:any) {
  const field=(name:string)=>data.rows?.[0]?.[data.columns?.findIndex((c:any)=>c.columnName===name)];
  const count=Number(field('row_count')),total=Number(field('total_count'));
  if(data.rows?.length!==1 || !Number.isInteger(count)||count<0||count>200||!Number.isInteger(total)||total<count||total>20000) throw new Error('Incomplete combined snapshot');
  const records=count?JSON.parse(field('records')):[];
  if(!Array.isArray(records)||records.length!==count) throw new Error('Incomplete combined snapshot');
  return {total,records:records.map((r:any[])=>({creditId:r[0],clientId:r[1],date:r[2],cents:Number(r[3]),hours:Number(r[4]),category:r[5],paymentMethod:r[6],parentCreditId:r[7],adjacentSales:Number(r[8]),calls:JSON.parse(r[9])})),
    watermarks:{calls:field('calls_updated_at'),purchases:field('purchases_updated_at'),matches:field('matches_updated_at')}};
}

export function combineAllocations(base:any,purchases:any[],exportRecords:any[],aliases:Record<string,string>,manuals:any[]=[]) {
  const rows=[...base.rows],unresolved=[...base.unresolved];
  const existing=new Set(exportRecords.filter(r=>r.creditId).map(r=>String(r.creditId)));
  base.rows.forEach((r:any)=>{if(r.credit_id)existing.add(String(r.credit_id));});
  // Ambiguous export matches and privately reviewed entries must not be counted a second time.
  const exportedClientDays=new Set(exportRecords.map(r=>`${r.clientId}:${r.date}`));
  const seen=new Set<string>(); let addedPurchases=0,addedRows=0,pendingPurchases=0;
  for(const p of purchases) {
    const id=String(p.creditId);
    if(seen.has(id)) throw new Error('Incomplete combined snapshot: duplicate purchase');
    seen.add(id);
    if(existing.has(id)||exportedClientDays.has(`${p.clientId}:${p.date}`)) continue;
    const calls=p.calls.filter((c:any[])=>['SENIOR','WINBACK','PROF_CERTS'].includes(c[2]));
    const select=(threshold:number)=>{
      const qualified=calls.filter((c:any[])=>c[3]!=null&&Number(c[3])>=threshold);
      return qualified.length?[...new Map([qualified[0],qualified.at(-1)].map((c:any)=>[String(c[0]),c])).values()].sort((a:any,b:any)=>String(a[0]).localeCompare(String(b[0]))):[];
    };
    const low=select(90),high=select(240),same=JSON.stringify(low.map((c:any)=>c[0]))===JSON.stringify(high.map((c:any)=>c[0]));
    const manualOverlap=manuals.some(m=>{
      if(m.status!=='approved'||String(m.saleDate||'').slice(0,7)!==p.date.slice(0,7)||String(m.adjustmentReason||m.reason||'').trim()==='Shifting Attro Between Reps')return false;
      let client=String(m.clientId||'').trim();
      if(!/^\d+$/.test(client)) {try{client=new URL(String(m.clientLink||'')).pathname.match(/\/clients\/(\d+)(?:\/|$)/)?.[1]||'';}catch{client='';}}
      return client===String(p.clientId)&&p.calls.some((c:any)=>aliases[String(c[1]).toLowerCase()]&&aliases[String(c[1]).toLowerCase()]===aliases[String(m.repName||'').toLowerCase()]);
    });
    let reason='';
    if(p.paymentMethod==='Refund') reason='Refund requires original allocation and session-use validation';
    else if(p.parentCreditId) reason='Linked or replacement purchase needs review';
    else if(p.category!=='1:1 Memberships') reason='Package classification needs review';
    else if(p.adjacentSales>0) reason='Multiple purchases within 24 hours need review';
    else if(!low.length || !same) reason='Qualifying call threshold or missing call history needs review';
    else if(low.some((c:any)=>c[2]==='PROF_CERTS')) reason='Cross-product allocation needs review';
    else if(!(p.cents>0)||!(p.hours>0)||!Number.isFinite(p.hours)) reason='Purchase amount or hours need review';
    else if(calls.some((c:any)=>c[3]==null)) reason='Call duration is missing';
    else if(manualOverlap) reason='Existing approved manual credit needs reconciliation';
    const relevant=(reason?p.calls:low).filter((c:any)=>aliases[String(c[1]).trim().toLowerCase()]);
    if(!relevant.length) continue;
    if(reason) {
      pendingPurchases++;
      for(const c of new Map(relevant.map((c:any)=>[String(c[0]),c])).values() as any) unresolved.push({ledgerId:`combined:${id}:${c[0]}`,creditId:id,clientId:String(p.clientId),date:p.date,manager:c[1],managerId:String(c[0]),attributionId:`combined:${id}`,reason,amountCents:p.cents,evidence:[p.creditId,p.cents,p.hours,p.paymentMethod,p.parentCreditId,p.calls]});
      continue;
    }
    addedPurchases++;
    for(const c of low as any[]) {
      rows.push({email:'',manager_name:c[1],manager_id:String(c[0]),client_id:String(p.clientId),credit_id:id,ledger_id:`combined:${id}:${c[0]}`,attribution_id:`combined:${id}`,attribution_date:p.date,occurred_at:p.date,members:1/low.length,sessions:Math.round(p.hours/low.length*100)/100,kind:'credit',provisional:true,attributionSource:'purchase-call-reconstruction'});
      addedRows++;
    }
  }
  return {...base,rows,unresolved,rule:'export-plus-purchase-calls-v1',combined:{addedPurchases,addedRows,pendingPurchases,scannedPurchases:purchases.length}};
}
