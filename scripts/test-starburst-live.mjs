import assert from 'node:assert/strict';
import fs from 'node:fs';
import {reconstruct as reconstructBase,parseLiveResult,inheritRefundMembership} from '../functions/_shared/starburst-reconstruction.mts';
import {liveQuery} from '../functions/_shared/starburst-live-query.mts';
const rules={schemaVersion:1,reviewedLedgers:{
  '40000038': {clientId:'40000068',attributionId:'40000077',managerId:'40000067',sourceDate:'2026-09-02',amountCents:29600,date:'2026-09-02',members:1,sessions:4},
  '40000040': {clientId:'40000070',attributionId:'40000079',managerId:'40000057',sourceDate:'2026-09-05',amountCents:52220.6,date:'2026-09-06',members:1,sessions:8},
  '40000041': {clientId:'40000066',attributionId:'40000076',managerId:'40000059',sourceDate:'2026-09-08',amountCents:-63900,date:'2026-09-08',members:-1,sessions:-8},
  '40000043': {clientId:'40000013',attributionId:'40000081',managerId:'40000059',sourceDate:'2026-09-10',amountCents:3000,date:'2026-09-10',members:0.5,sessions:0.67},
},excludedLedgerIds:['40000053','40000055'],reviewedAt:'2026-09-15'};
const reconstruct=(records)=>reconstructBase(records,rules);
const fixture=JSON.parse(fs.readFileSync(new URL('./fixtures/starburst-reference.json',import.meta.url)));
const data={columns:[{columnName:'row_count'},{columnName:'records'}],rows:[[String(fixture.length),JSON.stringify(fixture)]]};
const records=parseLiveResult(data), result=reconstruct(inheritRefundMembership(records));
const reference=JSON.parse(fs.readFileSync(new URL('../docs/verification/synthetic-reference.json',import.meta.url)));
for(const c of reference.cases){
  const matches=result.rows.filter(r=>r.manager_id==='40000064' && r.client_id===String(c.clientId) && r.attribution_date===c.date && r.members===c.members && r.sessions===c.hours);
  assert.equal(matches.length,1,`Reference case: ${c.case}`);
}
assert(result.superseded.includes('40000044'),'Old full credit is superseded');
const split=records.find(r=>String(r.ledgerId)==='40000045');
assert.equal(reconstruct([split]).rows.length,0,'Incomplete half allocation cannot appear complete');
assert.equal(reconstruct([split,{...split,creditId:999999}]).rows.length,0,'Ambiguous purchase must be excluded');
const full=records.find(r=>String(r.ledgerId)==='40000050');
assert.equal(reconstruct([full,{...full,id:999999,capturedAt:'2026-09-20 00:00:00 UTC',amountCents:0}]).rows.length,0,'Invalid latest version cannot restore the older version');
assert.equal(reconstruct([{...full,membershipFlag:null}]).rows.length,0,'Unknown membership classification is unresolved');
assert.equal(reconstruct([{...full,paymentMethod:'Transfer In'}]).rows.length,0,'Transfers are not new members');
assert.equal(reconstruct([full,full]).rows.length,1,'Repeated export is not double counted');
assert.throws(()=>parseLiveResult({...data,rows:[['999',data.rows[0][1]]]}),/Incomplete/);
assert.throws(()=>parseLiveResult({...data,rows:[['20001','[]']]}),/limit/);
assert.throws(()=>liveQuery('2026-99',['Example Rep 1']),/month/);
assert.throws(()=>liveQuery('2026-09',[]),/roster/);
assert(liveQuery('2026-09',["O'Neil"]).includes("o''neil"));
console.log('Starburst live: all six synthetic reference cases, superseded full credit, add-on preservation, ambiguity, incomplete splits, duplicates, input bounds passed.');

for (const delta of [-99.99, 99.99]) {
  const rounded = reconstruct([{...full,amountCents:Number(full.creditCents)+delta}]);
  assert.equal(rounded.rows.length,1);
  assert.equal(rounded.rows[0].members,1);
  assert.equal(rounded.rows[0].sessions,Number(full.hours));
}
for (const delta of [-100,100]) assert.equal(reconstruct([{...full,amountCents:Number(full.creditCents)+delta}]).rows.length,0);
const roundedSplit = [1,2].map(i=>({...full,id:String(900000+i),ledgerId:String(900000+i),managerId:String(i),creditCents:52220.63037249,amountCents:26110.3,hours:8}));
assert.deepEqual(reconstruct(roundedSplit).rows.map(r=>[r.members,r.sessions]),[[0.5,4],[0.5,4]]);
assert.equal(reconstruct([{...full,creditCents:150,amountCents:100}]).rows.length,0,'Ambiguous full/half allocation stays excluded');
console.log('Dollar tolerance: sub-dollar differences accepted, exact $1 rejected, rounded split normalized, ambiguous allocations excluded.');

const {refreshDue,refreshRetryDelay}=await import('../functions/_shared/starburst-live.mts');
assert.equal(refreshDue({fetchedAtMs:1000},null,60999),false);
assert.equal(refreshDue({fetchedAtMs:1000},null,61000),true);
assert.equal(refreshDue({fetchedAtMs:1000},{nextRetryAtMs:100000},61000),false);
assert.equal(refreshDue({fetchedAtMs:1000},{nextRetryAtMs:100000},100000),true);
assert.deepEqual([1,2,3,4,20].map(refreshRetryDelay),[60000,120000,240000,300000,300000]);
console.log('Refresh cadence and bounded failure backoff passed.');

const recoverySql=liveQuery('2026-09',['Example Rep 1']);
assert(recoverySql.includes('raw_redshift.vtwa.credits'));
assert(!recoverySql.includes('raw_sb_vtwa'));
const {parentMembershipQuery}=await import('../functions/_shared/starburst-reconstruction.mts');
assert(parentMembershipQuery(['10133568']).includes('raw_redshift.vtwa.credits'));
console.log('Main and refund-parent queries use the working Redshift source.');
const reviewedFixture=JSON.parse(fs.readFileSync(new URL('./fixtures/starburst-reviewed.json',import.meta.url)));
const reviewedRecords=parseLiveResult({columns:[{columnName:'row_count'},{columnName:'records'}],rows:[[String(reviewedFixture.length),JSON.stringify(reviewedFixture)]]});
const reviewedResult=reconstruct(inheritRefundMembership(reviewedRecords));
for (const [ledger,date,members,hours] of [['40000038','2026-09-02',1,4],['40000040','2026-09-06',1,8],['40000041','2026-09-08',-1,-8],['40000043','2026-09-10',0.5,0.67]]) {
 const rs=reviewedResult.rows.filter(r=>r.ledger_id===ledger);
 assert.equal(rs.length,1);assert.deepEqual([rs[0].attribution_date,rs[0].members,rs[0].sessions],[date,members,hours]);
}
const dunte=reviewedResult.rows.filter(r=>r.client_id==='40000068');
assert.equal(dunte.length,3,'Keep original eight-hour purchase, refund and replacement purchase');
assert.deepEqual(dunte.reduce((v,r)=>[v[0]+r.members,v[1]+r.sessions],[0,0]),[1,4]);
for (const id of ['40000053','40000055']) {
 assert(!reviewedResult.rows.some(r=>r.ledger_id===id));assert(!reviewedResult.unresolved.some(r=>r.ledgerId===id));
}
const correction=reviewedRecords.find(r=>String(r.ledgerId)==='40000038');
assert.equal(reconstruct([correction,correction]).rows.length,1,'Reviewed ledger remains deduplicated');
assert.equal(reconstruct([{...correction,amountCents:1}]).rows.length,0,'Changed source does not silently reuse an obsolete correction');
console.log('Synthetic correction scenarios, original/refund preservation, EOM exclusions and correction guards passed.');
