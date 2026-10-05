import assert from 'node:assert/strict';
import {sourceFreshness,sourceTimestampMs,SOURCE_MAX_AGE_MS} from '../functions/_shared/starburst-freshness.mts';
import {liveQuery} from '../functions/_shared/starburst-live-query.mts';
const now=Date.parse('2026-10-05T13:00:00Z');
const snapshot={month:'2026-10',sourceWatermarkVersion:1,sourceUpdatedAt:'2026-10-05 12:00:00.123456 UTC'};
assert.equal(sourceTimestampMs(snapshot.sourceUpdatedAt),Date.parse('2026-10-05T12:00:00.123Z'));
assert.equal(sourceTimestampMs('2026-10-05 12:00:00'),null);
assert.equal(sourceFreshness(snapshot,'2026-10',now).sourceStale,false);
assert.equal(sourceFreshness({...snapshot,sourceUpdatedAt:'2026-10-02 22:00:13.078424 UTC',fetchedAtMs:now},'2026-10',now).sourceStale,true,'Successful fetch does not freshen old source data');
assert.equal(sourceFreshness({...snapshot,sourceUpdatedAt:new Date(now-SOURCE_MAX_AGE_MS).toISOString()},'2026-10',now).sourceStale,false);
assert.equal(sourceFreshness({...snapshot,sourceUpdatedAt:new Date(now-SOURCE_MAX_AGE_MS-1).toISOString()},'2026-10',now).sourceStale,true);
for(const value of [null,'null','bad date','2026-10-06T00:00:00Z']){
 const result=sourceFreshness({...snapshot,sourceUpdatedAt:value},'2026-10',now);
 assert.equal(result.sourceFreshnessKnown,false);assert.equal(result.sourceStale,true);
}
assert.equal(sourceFreshness({...snapshot,sourceWatermarkVersion:undefined},'2026-10',now).sourceFreshnessKnown,false,'Legacy team-row timestamps are not feed watermarks');
assert.equal(sourceFreshness({...snapshot,month:'2026-09',sourceUpdatedAt:'2026-09-30T12:00:00Z'},'2026-10',now).sourceStale,false,'Closed month is not expected to have new sales');
const sql=liveQuery('2026-10',['Amanda Schaefer'],0,'2026-10-05T13:00:00.000Z');
assert(sql.includes('source_updated_at'));
const watermark=sql.slice(sql.indexOf('(SELECT CAST(max(created_at)'));
assert(!watermark.split('source_updated_at')[0].includes('manager'));
console.log('Source freshness: stale successful fetch, current export, boundary, missing/invalid/future timestamp, legacy snapshot and closed month passed.');
const combined={...snapshot,sourceUpdatedAt:'2026-10-02T22:00:00Z',combined:{},combinedWatermarks:{calls:'2026-10-05T12:00:00Z',purchases:'2026-10-05T12:30:00Z',matches:'2026-10-05T12:45:00Z'}};
assert.equal(sourceFreshness(combined,'2026-10',now).sourceStale,false);
assert.equal(sourceFreshness(combined,'2026-10',now).exportStale,true);
assert.equal(sourceFreshness(combined,'2026-10',now).sourceAgeMs,3600000);
for(const value of [null,'2026-10-02T22:00:00Z','2026-10-06T00:00:00Z'])assert.equal(sourceFreshness({...combined,combinedWatermarks:{...combined.combinedWatermarks,calls:value}},'2026-10',now).sourceStale,true);
console.log('Combined freshness uses the oldest component and preserves the export-delay signal.');
