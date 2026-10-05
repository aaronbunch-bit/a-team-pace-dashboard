import { randomUUID } from 'node:crypto';
import { accessToken, testStarburstConnection } from './_shared/starburst-oauth.mts';
import { allowed, connectionStore, setting, json } from './_shared/starburst-connection-test.mts';

// An isolated proof, not the dashboard feed. The body cannot supply SQL or credentials.
export default async (req: Request) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!allowed(req)) return json({ error: 'Unauthorized' }, 401);
  const store = connectionStore();
  const previous = await store.getWithMetadata('test-status', { type: 'json' });
  if (previous?.data?.state === 'running' && Date.now() - Date.parse(previous.data.startedAt) < 900_000) return;
  const startedAt = new Date().toISOString();
  const runId = randomUUID();
  const claim = await store.setJSON('test-status', { runId, state: 'running', startedAt }, previous?.etag ? { onlyIfMatch: previous.etag } : { onlyIfNew: true });
  if (!claim.modified || !claim.etag) return;
  try {
    const token = await accessToken(store as any, setting('STARBURST_TOKEN_ENCRYPTION_KEY'), setting('STARBURST_OAUTH_SEED'));
    const proof = await testStarburstConnection(token);
    await store.setJSON('test-status', { runId, state: 'succeeded', startedAt, ...proof }, { onlyIfMatch: claim.etag });
  } catch {
    // Never log upstream bodies, headers, tokens, or exception contents.
    await store.setJSON('test-status', { runId, state: 'failed', startedAt, checkedAt: new Date().toISOString(), message: 'The hosted connection test failed. The dashboard feed has not changed.' }, { onlyIfMatch: claim.etag });
  }
};
