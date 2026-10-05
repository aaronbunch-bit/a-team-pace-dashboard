import { getStore } from '@netlify/blobs';
import { setting } from './starburst-connection-test.mts';
import { FALLBACK_ROSTER_EMAILS } from './roster.mts';
import { teamTodayMonthKey } from './time.mts';
export function liveEnabled() { return !!setting('STARBURST_TOKEN_ENCRYPTION_KEY') && setting('STARBURST_LIVE_DISABLED') !== 'true'; }
export function liveStore() { return getStore({ name: 'starburst-live-v3', consistency: 'strong' }); }
export function liveMonth(raw: string | null) {
  if (!raw) return teamTodayMonthKey();
  if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(raw)) throw new Error('Invalid month');
  return raw;
}
export async function liveRoster() {
  const map: Record<string,string> = {...FALLBACK_ROSTER_EMAILS};
  const goals = await getStore('goals').get('current', {type:'json'}) as any;
  for (const [name,g] of Object.entries(goals || {}) as any) if (g?.email) map[String(g.email).trim().toLowerCase()] = name;
  // Explicit roster removal confirmed by Aaron, 2026-09-15.
  for (const [email,name] of Object.entries(map)) if (name.trim().toLowerCase()==='brenda wong' || email.split('@')[0]==='brenda.wong') delete map[email];
  return map;
}
export function rosterAliases(map: Record<string,string>) {
  const aliases: Record<string,string> = {};
  for (const [email,name] of Object.entries(map)) {
    aliases[name.trim().toLowerCase()] = email;
    // Existing roster emails supply formal-name variants such as Tim/Timothy.
    aliases[email.split('@')[0].replace(/[._]/g,' ').toLowerCase()] = email;
  }
  return aliases;
}
export async function requestLiveRefresh(month: string) {
  const response = await fetch('https://lizards-autopacer.netlify.app/.netlify/functions/refresh-starburst-background?month=' + encodeURIComponent(month), {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
    headers: {Authorization: 'Bearer ' + setting('STARBURST_CONNECTION_TEST_KEY')}
  });
  if (response.status !== 202) throw new Error('Live refresh could not start');
}

export const LIVE_REFRESH_MS = 60_000;
export function refreshRetryDelay(failures:number) {
  return Math.min(300_000, LIVE_REFRESH_MS * 2 ** Math.min(Math.max(0, failures - 1), 3));
}
export function refreshDue(snapshot:any, status:any, now=Date.now()) {
  return (!snapshot?.fetchedAtMs || now-snapshot.fetchedAtMs>=LIVE_REFRESH_MS) && !(status?.nextRetryAtMs>now);
}
