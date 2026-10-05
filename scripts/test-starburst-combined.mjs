import assert from 'node:assert/strict';
import {combinedQuery,parseCombinedResult,combineAllocations} from '../functions/_shared/starburst-combined.mts';
import {validateDecision} from '../functions/_shared/unmatched-reviews.mts';
const base={rows:[],unresolved:[],superseded:[]},aliases={'rep one':'one@example.test'};
const call=(id,name,seconds=300,role='SENIOR')=>[id,name,role,String(seconds),'2026-10-03 12:00:00 UTC','conference-'+id,id];
const sale={creditId:'90001',clientId:'70001',date:'2026-10-03',cents:10000,hours:4,category:'1:1 Memberships',paymentMethod:'Web Site',adjacentSales:0,calls:[call('11','Rep One')]};
const run=(p=sale,b=base,e=[])=>combineAllocations(b,[p],e,aliases);
assert.equal(run().rows[0].members,1);
assert.equal(run().rows[0].sessions,4);
const split=run({...sale,calls:[call('11','Rep One'),call('22','Other Team')]});
assert.equal(split.rows.length,2);assert.equal(split.rows[0].members,.5);assert.equal(split.rows[1].sessions,2);
assert.equal(split.rows.reduce((n,r)=>n+r.members,0),1);
assert.equal(run(sale,base,[{creditId:'90001'}]).rows.length,0);
assert.equal(run(sale,base,[{clientId:'70001',date:'2026-10-03'}]).rows.length,0);
const existing={...base,rows:[{credit_id:'90001',members:.5}]};
assert.deepEqual(run(sale,existing).rows,existing.rows);
assert.throws(()=>combineAllocations(base,[sale,sale],[],aliases),/duplicate/);
for(const p of [
  {...sale,paymentMethod:'Refund',cents:-10000,hours:-4},
  {...sale,parentCreditId:'90000'},
  {...sale,adjacentSales:1},
  {...sale,calls:[call('11','Rep One',100),call('22','Other Team',300)]},
  {...sale,calls:[call('11','Rep One',300,'PROF_CERTS')]},
  {...sale,hours:NaN},
  {...sale,category:null},
  {...sale,calls:[call('11','Rep One',0)]},
]){const r=run(p);assert.equal(r.rows.length,0);assert.ok(r.unresolved.length);}
assert.equal(run({...sale,calls:[call('11','Rep One'),call('11','Rep One')]}).rows.length,1);
assert.equal(run({...sale,calls:[call('22','Other Team')]}).rows.length,0);
const manual={status:'approved',clientId:'70001',repName:'Rep One',saleDate:'2026-10-04',members:1,sessions:4};
assert.equal(combineAllocations(base,[sale],[],aliases,[manual]).rows.length,0,'Approved manual entries cannot be counted again');
assert.equal(combineAllocations(base,[sale],[],aliases,[{...manual,reason:'Shifting Attro Between Reps'}]).rows.length,1,'Transfer adjustments still apply to original credit');
assert.equal(validateDecision({action:'approve',ledgerId:'combined:90001:11',note:'Verified',members:1,sessions:4}).members,1);
assert.throws(()=>validateDecision({action:'approve',ledgerId:'combined:bad:11',note:'Verified',members:1,sessions:4}));
assert.throws(()=>combinedQuery('2026-13',['Rep One']));
assert.throws(()=>combinedQuery('2026-10',[]));
assert.match(combinedQuery('2026-10',["O'Example"]),/o''example/);
assert.throws(()=>parseCombinedResult({columns:[],rows:[]}));
console.log('Combined attribution invariants passed');
