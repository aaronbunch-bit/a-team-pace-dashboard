import { timingSafeEqual } from 'node:crypto';
import { getStore } from '@netlify/blobs';

export function setting(name: string): string {
  return (globalThis as any).Netlify?.env?.get(name) || '';
}
export function allowed(req: Request): boolean {
  const expected = setting('STARBURST_CONNECTION_TEST_KEY');
  const supplied = req.headers.get('authorization')?.replace(/^Bearer /, '') || '';
  if (expected.length < 32 || supplied.length !== expected.length) return false;
  const a = Buffer.from(supplied); const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function connectionStore() {
  return getStore({ name: 'private-starburst-connection', consistency: 'strong' });
}
export function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}
