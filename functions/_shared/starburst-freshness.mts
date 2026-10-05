/** Query success and upstream export recency are separate signals. */
export const SOURCE_MAX_AGE_MS = 3 * 60 * 60 * 1000;
export function sourceTimestampMs(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const normalized=value.trim().replace(/ UTC$/, 'Z').replace(' ', 'T').replace(/(\.\d{3})\d+/, '$1');
  // Starburst timestamp-with-zone output must carry a timezone; never assume local time.
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(normalized)) return null;
  const ms=Date.parse(normalized);
  return Number.isFinite(ms) ? ms : null;
}
export function sourceFreshness(snapshot: any, currentMonth: string, now=Date.now()) {
  if(snapshot?.combined && snapshot?.combinedWatermarks) {
    const stamps=['calls','purchases','matches'].map(k=>sourceTimestampMs(snapshot.combinedWatermarks[k]));
    const known=stamps.every(ms=>ms!==null&&ms<=now+60_000);
    const oldest=known?Math.min(...stamps as number[]):null;
    const sourceAgeMs=oldest===null?null:Math.max(0,now-oldest);
    const sourceStale=snapshot.month===currentMonth&&(!known||sourceAgeMs!>SOURCE_MAX_AGE_MS);
    const exportMs=sourceTimestampMs(snapshot.sourceUpdatedAt);
    return {sourceStale,sourceAgeMs,sourceFreshnessKnown:known,sourceMaxAgeMs:SOURCE_MAX_AGE_MS,
      exportStale:snapshot.month===currentMonth&&(exportMs===null||now-exportMs>SOURCE_MAX_AGE_MS),
      combinedSourceUpdatedAt:oldest===null?null:new Date(oldest).toISOString(),
      sourceStaleReason:sourceStale?'One or more purchase/call sources are delayed or their freshness is unknown. Reconstructed totals may be incomplete.':undefined};
  }
  const ms=snapshot?.sourceWatermarkVersion===1 ? sourceTimestampMs(snapshot.sourceUpdatedAt) : null;
  const known=ms!==null && ms<=now+60_000;
  const sourceAgeMs=known ? Math.max(0,now-ms!) : null;
  const sourceStale=snapshot?.month===currentMonth && (!known || sourceAgeMs!>SOURCE_MAX_AGE_MS);
  return {sourceStale,sourceAgeMs,sourceFreshnessKnown:known,sourceMaxAgeMs:SOURCE_MAX_AGE_MS,
    sourceStaleReason:sourceStale ? (known
      ? 'No new attribution export in over 3 hours. Totals may be incomplete; refreshing the pacer cannot recover missing upstream records.'
      : 'Attribution export freshness could not be verified. Totals may be incomplete.') : undefined};
}
