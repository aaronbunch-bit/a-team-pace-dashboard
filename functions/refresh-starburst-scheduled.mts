import {liveEnabled,liveMonth,requestLiveRefresh} from './_shared/starburst-live.mts';
export default async () => { if (liveEnabled()) await requestLiveRefresh(liveMonth(null)); };
export const config = {schedule:'* * * * *'};
