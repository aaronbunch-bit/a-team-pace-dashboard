import assert from 'node:assert/strict';
import { accessToken, seal, unseal, testStarburstConnection } from '../functions/_shared/starburst-oauth.mts';
import { allowed } from '../functions/_shared/starburst-connection-test.mts';
const secret = 'ab'.repeat(32);
const expired = { access_token: 'old-access-secret', refresh_token: 'old-refresh-secret', expires_at: 0 };
const seed = seal(expired, secret);
assert(!seed.includes(expired.refresh_token));
assert.deepEqual(unseal(seed, secret), expired);
assert.throws(() => unseal(seed, 'cd'.repeat(32)));
assert.throws(() => unseal(seed.slice(1), secret));
class MemoryStore {
  value = null; revision = 0;
  async getWithMetadata() { return this.value === null ? null : { data: this.value, etag: String(this.revision) }; }
  async setJSON(key, value, options) {
    if ((options.onlyIfNew && this.value !== null) || (options.onlyIfMatch && options.onlyIfMatch !== String(this.revision))) return { modified: false };
    this.value = value; return { modified: true, etag: String(++this.revision) };
  }
}
const store = new MemoryStore(); let calls = 0;
const renewal = async (url, options) => {
  calls++; assert.equal(url, 'https://nerdy.galaxy.starburst.io/oauth/v2/token');
  assert.equal(options.redirect, 'error');
  assert.equal(options.body.get('refresh_token'), expired.refresh_token);
  return Response.json({ access_token: 'new-access-secret', refresh_token: 'new-refresh-secret', expires_in: 14400, scope: 'galaxy.mcp' });
};
const concurrent = await Promise.allSettled([accessToken(store, secret, seed, renewal), accessToken(store, secret, seed, renewal)]);
assert.equal(calls, 1, 'Only one invocation may spend the refresh token');
assert(concurrent.some(x => x.status === 'fulfilled'));
assert.equal(await accessToken(store, secret, seed, renewal), 'new-access-secret');
assert.equal(calls, 1, 'Valid access token is reused');
assert.equal(unseal(store.value, secret).refresh_token, 'new-refresh-secret');
const failed = new MemoryStore(); let failureCalls = 0;
const fail = async () => { failureCalls++; throw new Error('sensitive upstream response'); };
await assert.rejects(accessToken(failed, secret, seed, fail), /reconnect required/);
await assert.rejects(accessToken(failed, secret, seed, fail), /in progress or requires reconnecting/);
assert.equal(failureCalls, 1, 'Do not replay a refresh token after an uncertain result');
let queries = 0;
const mockMcp = async (url, options) => {
  assert.equal(url, 'https://nerdy.mcp.galaxy.starburst.io');
  assert.equal(options.redirect, 'error');
  assert.equal(options.headers.Authorization, 'Bearer test-access');
  const body = JSON.parse(options.body);
  if (body.method === 'initialize') return Response.json({ id: 1, result: { protocolVersion: '2025-06-18' } }, { headers: { 'mcp-session-id': 'session-a' } });
  assert.equal(options.headers['Mcp-Session-Id'], 'session-a');
  if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
  queries++; assert.deepEqual(body.params.arguments, { clusterName: 'adhoc', queryText: 'SHOW CATALOGS' });
  const payload = 'data: {"method":"notifications/progress"}\r\n\r\ndata: ' + JSON.stringify({ id: 2, result: { structuredContent: { queryId: 'query-123', rows: [['catalog-a']] } } }) + '\r\n\r\n';
  const bytes = new TextEncoder().encode(payload);
  return new Response(new ReadableStream({ start(c) { c.enqueue(bytes.slice(0, 73)); c.enqueue(bytes.slice(73)); c.close(); } }), { headers: { 'Content-Type': 'text/event-stream' } });
};
const result = await testStarburstConnection('test-access', mockMcp);
assert.equal(result.connected, true); assert.equal(result.catalogCount, 1); assert.equal(queries, 1);
assert(!JSON.stringify(result).includes('test-access'));
await assert.rejects(testStarburstConnection('test-access', async () => new Response('secret upstream', { status: 401 })), /HTTP 401/);
globalThis.Netlify = { env: { get: () => 'x'.repeat(40) } };
assert.equal(allowed(new Request('https://example.com')), false);
assert.equal(allowed(new Request('https://example.com', { headers: { Authorization: 'Bearer ' + 'x'.repeat(40) } })), true);
assert.equal(allowed(new Request('https://example.com', { headers: { Authorization: 'Bearer ' + 'y'.repeat(40) } })), false);
console.log('Starburst OAuth tests passed: encryption, rotation, concurrency, interrupted renewal, SSE, fixed query, private access.');

await assert.rejects(testStarburstConnection('test-access',async(url,options)=>{
 const body=JSON.parse(options.body);
 if(body.method!=='tools/call') return mockMcp(url,options);
 return Response.json({id:2,result:{isError:true,content:[{type:'text',text:'FATAL: (ECIRCUITBREAKER) too many authentication failures; hidden-secret'}]}});
}),error=>error.message==='Starburst purchases connection blocked after authentication failures; database connection repair required');
console.log('Database outage is reported without exposing upstream details.');
