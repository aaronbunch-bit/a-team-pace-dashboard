/* Admin-only Starburst decisions. All untrusted record text uses textContent. */
(()=>{
 const tabs=document.getElementById('attrPageTabs');if(!tabs)return;
 const button=document.createElement('button');button.type='button';button.className='attr-page-tab';button.dataset.attrTab='unmatched';button.hidden=true;button.setAttribute('role','tab');button.textContent='Unmatched records';tabs.append(button);
 const panel=document.createElement('div');panel.className='attr-page-panel';panel.dataset.attrPanel='unmatched';panel.setAttribute('role','tabpanel');tabs.after(panel);
 const node=(tag,text,cls)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;};
 panel.append(node('h2','Review unmatched records'),node('p','Check existing credit below, then approve or exclude each record. Avoid approving amounts already on the rep’s pacer.','meta-note'));
 const controls=node('div',undefined,'review-controls'),month=node('input');month.type='month';month.value=liveMonthKey();month.setAttribute('aria-label','Review month');
 const filter=node('select');filter.setAttribute('aria-label','Review status');for(const [value,text]of [['pending','Needs review'],['reviewed','Reviewed / history']]){const o=node('option',text);o.value=value;filter.append(o);}
 const reload=node('button','Refresh');reload.type='button';const monthLabel=node('label','Month'),statusLabel=node('label','Status');monthLabel.append(month);statusLabel.append(filter);controls.append(monthLabel,statusLabel,reload);panel.append(controls);
 const status=node('p','','meta-note');status.setAttribute('role','status');const list=node('div');panel.append(status,list);
 let data=null,busy=false,loadId=0;
 const alert=node('button','', 'unmatched-home-alert');alert.type='button';alert.id='unmatchedHomeAlert';alert.hidden=true;
 document.getElementById('teamSourceNote')?.before(alert);
 if(!alert.isConnected)document.getElementById('teamCard')?.before(alert);
 let latest=null;
 function syncAlert(){
  const allowed=typeof isRealAdmin==='function'&&isRealAdmin()&&!(typeof getViewAsRepRaw==='function'&&getViewAsRepRaw());
  button.hidden=!allowed;
  if(!allowed&&location.hash==='#manual-attribution-unmatched')location.hash='manual-attribution';
  alert.hidden=!allowed||!latest||latest.month!==liveMonthKey()||!(latest.count>0);
  if(!alert.hidden)alert.textContent=`⚠ ${latest.count} unmatched record${latest.count===1?'':'s'} need${latest.count===1?'s':''} admin attention — Review now${latest.stale?' · Last saved data':''}`;
 }
 window.addEventListener('pacer:unmatched',event=>{latest=event.detail;syncAlert();});
 setInterval(syncAlert,1000);
 alert.addEventListener('click',()=>{
  if(!isRealAdmin())return;
  month.value=liveMonthKey();filter.value='pending';
  if(location.hash==='#manual-attribution-unmatched')load();
  else location.hash='manual-attribution-unmatched';
 });
 const endpoint=()=>'/api/starburst/reviews?month='+encodeURIComponent(month.value);
 function input(label,type){const wrap=node('label',label);const el=node(type==='textarea'?'textarea':'input');if(type!=='textarea')el.type=type;el.setAttribute('aria-label',label);wrap.append(el);return {wrap,el};}
 function render(){list.replaceChildren();if(!data)return;
  const pending=filter.value==='pending',items=pending?data.pending:data.decisions.filter(d=>d.action!=='reopen');
  status.textContent=`${data.pending.length} need review · Snapshot checked ${new Date(data.fetchedAt).toLocaleString()}${Date.now()-new Date(data.fetchedAt).getTime()>180000?' · Refresh delayed; source may be stale':''}`;
  if(!items.length)list.append(node('p',pending?'No records need review for this month.':'No active decisions for this month.'));
  for(const item of items){const r=pending?item:item.record;const card=node('section',undefined,'review-record');
   card.append(node('h3',r.rep||r.manager),node('p',`Client ${r.clientId} · ${r.date} · Record ${r.ledgerId}`),node('p',r.reason,'meta-note'));
   const check=pending?r.pacerCheck:item.pacerCheck;
   if(check){const box=node('div',undefined,'pacer-client-check');
    box.append(node('strong',check.found?'Already on this rep’s pacer':check.manualRequests?.length?'Client has manual requests; no credited entry found':'No existing credited entry found'),node('p',`${check.rep} · ${check.month} · Starburst and approved manual attributions`,'meta-note'));
    if(check.found){box.append(node('p',`${check.entries.length} existing entry/entries · Net ${check.members} members / ${check.sessions} sessions. This is a possible duplicate, not proof of one.`));for(const entry of check.entries)box.append(node('p',`${entry.source} · ${entry.date} · ${entry.members} members / ${entry.sessions} sessions · Record ${entry.id}`,'meta-note'));}
    for(const request of check.manualRequests||[])box.append(node('p',`Manual request ${request.id} · ${request.status} · ${request.date} · ${request.members} members / ${request.sessions} sessions · Not included in totals`,'meta-note'));
    if(check.unidentifiedManualEntries)box.append(node('p',`${check.unidentifiedManualEntries} approved manual entry/entries have no identifiable client ID and could not be checked.`,'meta-note'));
    const open=node('a','Open individual pacer ↗');open.href='#individual-pacer='+encodeURIComponent(check.rep);open.addEventListener('click',async event=>{if(check.month===liveMonthKey()||check.month===previousMonthKeyFromActuals()?.key){event.preventDefault();if(check.month!==liveMonthKey())await ensurePriorMonthBundle({fresh:true});opsMonthMode=check.month===liveMonthKey()?'current':'prior';pacerTab='current';location.hash='individual-pacer='+encodeURIComponent(check.rep);}});box.append(open);card.append(box);
   }else card.append(node('p','Existing-client check unavailable. Refresh before deciding.','meta-note'));
   if(r.amountCents!=null)card.append(node('p',`Source credited amount: ${(Number(r.amountCents)/100).toLocaleString(undefined,{style:'currency',currency:'USD'})}`,'meta-note'));
   if(r.evidence?.length){const evidence=node('details');evidence.append(node('summary','Source match details'));for(const e of r.evidence)evidence.append(node('p',`Purchase ${e[3]||'not matched'} · purchase sessions ${e[5]??'unknown'} · membership ${e[6]===1?'yes':e[6]===0?'no':'unknown'} · payment type ${e[7]||'unknown'}`,'meta-note'));card.append(evidence);}
   if(r.previousDecision)card.append(node('p',r.previousDecision,'meta-note'));
   const previous=data.decisions.find(d=>d.ledgerId===String(r.ledgerId));
   const fields=node('div',undefined,'review-controls');const members=input('Verified net members','number'),sessions=input('Verified net sessions','number'),note=input('Review note','textarea');members.el.step='0.5';sessions.el.step='0.01';note.el.maxLength=2000;
   if(pending){fields.append(members.wrap,sessions.wrap);card.append(fields,node('p','Use negative amounts for refunds; enter 0 for a metric with no credit.','meta-note'));}
   else card.append(node('p',`${item.action==='approve'?'Approved':'Denied'}${item.action==='approve'?` · ${item.members} members / ${item.sessions} sessions`:''} · ${item.by} · ${new Date(item.at).toLocaleString()}`),node('p',item.note),node('p',item.effect||'','meta-note'));
   card.append(note.wrap);const actions=node('div',undefined,'review-controls');
   for(const action of pending?['approve','deny']:['reopen']){const b=node('button',action==='approve'?'Approve & include':action==='deny'?'Deny & exclude':'Reopen review');b.type='button';b.addEventListener('click',async()=>{
    if(busy)return;
    if(!note.el.value.trim()){note.el.focus();status.textContent='A review note is required.';return;}
    if(action==='approve'&&(members.el.value===''||sessions.el.value==='')){status.textContent='Enter both verified amounts, including zero where applicable.';return;}
    busy=true;panel.querySelectorAll('button,input,select,textarea').forEach(e=>e.disabled=true);status.textContent='Saving decision…';
    try{await authedFetch(endpoint(),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,ledgerId:String(r.ledgerId),fingerprint:r.reviewFingerprint,members:members.el.value,sessions:sessions.el.value,note:note.el.value,expectedAt:previous?.at||''})});await fetchLiveActuals({fresh:true});if(month.value===previousMonthKeyFromActuals()?.key)await ensurePriorMonthBundle({fresh:true});quietRefreshFromActuals();await load();}
    catch(e){status.textContent=e.message||'Could not save. Reload before retrying.';}
    finally{busy=false;panel.querySelectorAll('button,input,select,textarea').forEach(e=>e.disabled=false);}
   });actions.append(b);}card.append(actions);list.append(card);
  }
  if(!pending&&data.history.length){const history=node('details');history.append(node('summary','Decision history'));for(const h of data.history)history.append(node('p',`${new Date(h.at).toLocaleString()} · ${h.by} · ${h.action} · ${h.record.manager} · client ${h.record.clientId} · record ${h.ledgerId} · ${h.note}`,'meta-note'));list.append(history);}
 }
 async function load(){const id=++loadId;list.replaceChildren();data=null;status.textContent='Loading review queue…';try{const result=await authedFetch(endpoint());if(id!==loadId)return;data=result;if(result.month===liveMonthKey()){latest={month:result.month,count:result.pending.length,stale:Date.now()-new Date(result.fetchedAt).getTime()>180000};syncAlert();}render();}catch(e){if(id===loadId)status.textContent=e.message||'Unable to load review queue.';}}
 function loadRoute(){if(location.hash==='#manual-attribution-unmatched'&&isRealAdmin()&&!getViewAsRepRaw())load();}
 window.addEventListener('hashchange',loadRoute);syncAlert();
 if(location.hash==='#manual-attribution-unmatched'){renderManualAttroPage();loadRoute();}
 reload.addEventListener('click',load);month.addEventListener('change',load);filter.addEventListener('change',render);
})();
