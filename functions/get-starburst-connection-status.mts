import { allowed, connectionStore, json } from './_shared/starburst-connection-test.mts';
export default async (req: Request) => {
  if (req.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
  if (!allowed(req)) return json({ error: 'Unauthorized' }, 401);
  return json(await connectionStore().get('test-status', { type: 'json' }) || { state: 'not-tested' });
};
export const config = { path: '/api/starburst/connection-status' };
