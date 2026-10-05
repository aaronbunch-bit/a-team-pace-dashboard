import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const TOKEN_URL = 'https://nerdy.galaxy.starburst.io/oauth/v2/token';
const MCP_URL = 'https://nerdy.mcp.galaxy.starburst.io';
const CLIENT_ID = 'cursor_mcp@nerdy.galaxy.starburst.io';
const AAD = Buffer.from('lizards-autopacer:starburst-oauth:v1');
const RECORD = 'connection-v3-20260929';

type Credential = { access_token: string; refresh_token: string; expires_at: number; phase?: 'refreshing' };
type Store = {
  getWithMetadata(key: string, options: { type: 'json' }): Promise<{ data: unknown; etag: string } | null>;
  setJSON(key: string, value: unknown, options: { onlyIfNew?: boolean; onlyIfMatch?: string }): Promise<{ modified: boolean; etag?: string }>;
};

function encryptionKey(secret: string) {
  if (!/^[0-9a-f]{64}$/i.test(secret)) throw new Error('Starburst encryption key is not configured');
  return Buffer.from(secret, 'hex');
}
export function seal(value: unknown, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(secret), iv);
  cipher.setAAD(AAD);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map(x => x.toString('base64url')).join('.');
}
export function unseal(value: unknown, secret: string): Credential {
  try {
    const parts = String(value).split('.');
    if (parts.length !== 3) throw new Error();
    const [iv, tag, data] = parts.map(x => Buffer.from(x, 'base64url'));
    const cipher = createDecipheriv('aes-256-gcm', encryptionKey(secret), iv);
    cipher.setAAD(AAD); cipher.setAuthTag(tag);
    const result = JSON.parse(Buffer.concat([cipher.update(data), cipher.final()]).toString('utf8'));
    if (typeof result.access_token !== 'string' || !result.access_token ||
        typeof result.refresh_token !== 'string' || !result.refresh_token ||
        !Number.isFinite(result.expires_at) || (result.phase && result.phase !== 'refreshing')) throw new Error();
    return result;
  } catch { throw new Error('Starburst credential could not be decrypted'); }
}

/** A conditional write claims renewal BEFORE spending a rotating refresh token.
 * An interrupted/ambiguous renewal stays locked and requires reconnecting;
 * we never replay an old refresh token after an uncertain outcome. */
export async function accessToken(store: Store, secret: string, encryptedSeed: string, fetcher = fetch): Promise<string> {
  let record = await store.getWithMetadata(RECORD, { type: 'json' });
  if (!record) {
    unseal(encryptedSeed, secret);
    await store.setJSON(RECORD, encryptedSeed, { onlyIfNew: true });
    record = await store.getWithMetadata(RECORD, { type: 'json' });
  }
  if (!record?.etag) throw new Error('Starburst credential storage is unavailable');
  const tokens = unseal(record.data, secret);
  if (tokens.phase === 'refreshing') throw new Error('Starburst renewal is in progress or requires reconnecting');
  if (tokens.expires_at > Date.now() + 120_000) return tokens.access_token;
  const claim = await store.setJSON(RECORD, seal({ ...tokens, phase: 'refreshing' }, secret), { onlyIfMatch: record.etag });
  if (!claim.modified || !claim.etag) throw new Error('Starburst renewal is already in progress');
  try {
    const response = await fetcher(TOKEN_URL, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: CLIENT_ID, refresh_token: tokens.refresh_token }),
    });
    if (!response.ok) throw new Error();
    const next = await response.json();
    if (typeof next.access_token !== 'string' || !next.access_token ||
        !(Number(next.expires_in) > 0) ||
        (next.scope && next.scope !== 'galaxy.mcp')) throw new Error();
    const refreshed: Credential = {
      access_token: next.access_token,
      refresh_token: next.refresh_token || tokens.refresh_token,
      expires_at: Date.now() + Number(next.expires_in) * 1000,
    };
    if (typeof refreshed.refresh_token !== 'string') throw new Error();
    const saved = await store.setJSON(RECORD, seal(refreshed, secret), { onlyIfMatch: claim.etag });
    if (!saved.modified) throw new Error();
    return refreshed.access_token;
  } catch { throw new Error('Starburst renewal did not complete safely; reconnect required'); }
}

/** Internal transport: query text is generated on the server, never accepted by an HTTP route. */
export async function queryStarburst(token: string, queryText: string, fetcher = fetch) {
  if (!/^(SELECT|WITH|SHOW)\b/i.test(queryText.trim()) || queryText.includes(";")) throw new Error("Invalid read-only query");
  let session = '';
  const signal = AbortSignal.timeout(600_000);
  async function rpc(message: Record<string, any>) {
    let response: Response;
    try {
      response = await fetcher(MCP_URL, {
        method: 'POST', redirect: 'error', signal,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${token}`, 'MCP-Protocol-Version': '2025-06-18',
          ...(session ? { 'Mcp-Session-Id': session } : {}) },
        body: JSON.stringify({ jsonrpc: '2.0', ...message }),
      });
    } catch { throw new Error('Starburst connection timed out or was unavailable'); }
    if (!response.ok) throw new Error(`Starburst connection returned HTTP ${response.status}`);
    session = response.headers.get('mcp-session-id') || session;
    if (message.id === undefined) { await response.body?.cancel(); return; }
    let result: any;
    if (response.headers.get('content-type')?.includes('text/event-stream')) {
      if (!response.body) throw new Error('Starburst response was empty');
      const reader = response.body.getReader();
      const decoder = new TextDecoder(); let pending = ''; let received = 0;
      try {
        while (!result) {
          const chunk = await reader.read();
          if (chunk.done) break;
          received += chunk.value.byteLength;
          if (received > 8_000_000) throw new Error('Starburst connection response exceeded its limit');
          pending += decoder.decode(chunk.value, { stream: true });
          const frames = pending.split(/\r?\n\r?\n/); pending = frames.pop() || '';
          for (const frame of frames) {
            const data = frame.split(/\r?\n/).filter(x => x.startsWith('data:')).map(x => x.slice(5).trimStart()).join('\n');
            if (!data) continue;
            const candidate = JSON.parse(data);
            if (candidate.id === message.id) result = candidate;
          }
        }
      } catch { throw new Error('Starburst response was interrupted or invalid'); }
      finally { await reader.cancel().catch(() => {}); }
    } else {
      const body = await response.text();
      if (body.length > 8_000_000) throw new Error('Starburst connection response exceeded its limit');
      try { result = JSON.parse(body); } catch { throw new Error('Starburst response was invalid'); }
    }
    if (result?.id !== message.id || result.error || !result.result) throw new Error('Starburst connection test failed');
    return result.result;
  }
  await rpc({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'autopacer-connection-test', version: '1.0.0' } } });
  await rpc({ method: 'notifications/initialized' });
  const result = await rpc({ id: 2, method: 'tools/call', params: { name: 'executeSqlQueryReadOnly', arguments: { clusterName: 'adhoc', queryText } } });
  if (result.isError) {
    const errorText = (result.content || []).filter((b:any)=>b.type==='text').map((b:any)=>String(b.text)).join(' ');
    if (/ECIRCUITBREAKER|too many authentication failures/i.test(errorText)) throw new Error('Starburst purchases connection blocked after authentication failures; database connection repair required');
    throw new Error('Starburst read-only query failed');
  }
  let data = result.structuredContent;
  if (!data) for (const block of result.content || []) {
    if (block.type === 'text') { try { data = JSON.parse(block.text); } catch { /* Non-JSON explanatory text. */ } }
    if (data?.rows) break;
  }
  if (!Array.isArray(data?.rows) || !data.rows.length || typeof data.queryId !== 'string') throw new Error('Starburst query result was not recognized');
  return data;
}

export async function testStarburstConnection(token: string, fetcher = fetch) {
  const data = await queryStarburst(token, 'SHOW CATALOGS', fetcher);
  return { connected: true, queryId: data.queryId, catalogCount: data.rows.length, checkedAt: new Date().toISOString() };
}
