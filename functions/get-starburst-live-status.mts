import {allowed,json} from './_shared/starburst-connection-test.mts';
import {liveMonth,liveStore} from './_shared/starburst-live.mts';
export default async (req: Request) => {
  if (req.method !== 'GET') return json({error:'Method not allowed'},405);
  if (!allowed(req)) return json({error:'Unauthorized'},401);
  let month: string; try {month=liveMonth(new URL(req.url).searchParams.get('month'));} catch {return json({error:'Invalid month'},400);}
  const store=liveStore(), snapshot=await store.get(`month:${month}`,{type:'json'}) as any;
  return json({status:await store.get(`status:${month}`,{type:'json'}),snapshot});
};
export const config={path:'/api/starburst/live-status'};
