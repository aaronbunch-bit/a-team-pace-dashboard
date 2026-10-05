/** Latest-export reconstruction; intentionally distinct from the authoritative Flex ledger. */
export function liveQuery(month: string, names: string[], page = 0, asOf = new Date().toISOString()) {
  if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('Invalid month');
  if (!names.length || names.length > 200) throw new Error('Invalid roster');
  if (!Number.isInteger(page) || page < 0 || page > 200 || !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(asOf)) throw new Error('Invalid page');
  const scope = names.map(n => `'${n.trim().toLowerCase().replace(/'/g, "''")}'`).join(',');
  return `WITH a AS (
    SELECT *, row_number() OVER (PARTITION BY ledger_id ORDER BY created_at DESC,id DESC) rn
    FROM raw_sb_acquisition_analytics.public.vt_attributions
    WHERE attribution_id IN (SELECT attribution_id FROM raw_sb_acquisition_analytics.public.vt_attributions WHERE lower(trim(manager)) IN (${scope}) AND attribution_date >= DATE '${month}-01' AND attribution_date < DATE '${month}-01' + INTERVAL '1' MONTH)
      AND created_at <= from_iso8601_timestamp('${asOf}')
      AND attribution_date >= DATE '${month}-01'
      AND attribution_date < DATE '${month}-01' + INTERVAL '1' MONTH
  ), recent AS (SELECT * FROM a WHERE rn=1), candidates AS (
    SELECT a.id,a.ledger_id,a.attribution_id,a.client_id,a.manager,a.manager_id,
      CAST(a.attribution_date AS varchar) attribution_date,
      CAST(a.created_at AS varchar) captured_at,try_cast(a.amount AS double) amount_cents,
      c.parent_credit_id, c.id credit_id, CAST(c.payment_amount AS double) credit_cents,
      CAST(c.duration AS double)/3600 hours,
      coalesce(s.membership_flag,CASE WHEN c.payment_category='1:1 Memberships' THEN 1 ELSE NULL END) membership_flag,
      c.payment_method, CAST(c.created_at AS varchar) credit_created_at,
      CAST(c.updated_at AS varchar) credit_updated_at
    FROM recent a
    LEFT JOIN raw_redshift.vtwa.credits c
      ON c.client_id=try_cast(a.client_id AS integer)
      AND c.created_at >= TIMESTAMP '${month}-01 00:00:00'
      AND c.created_at < TIMESTAMP '${month}-01 00:00:00' + INTERVAL '1' MONTH + INTERVAL '1' DAY
      AND CAST(at_timezone(with_timezone(c.created_at,'UTC'),'America/Chicago') AS date)=a.attribution_date
      AND (abs(CAST(c.payment_amount AS double)-try_cast(a.amount AS double))<100
        OR abs(CAST(c.payment_amount AS double)*0.5-try_cast(a.amount AS double))<100)
    LEFT JOIN silver.credits.slv_credits s ON s.credit_id=c.id AND s.credit_created_at >= TIMESTAMP '${month}-01 00:00:00' AND s.credit_created_at < TIMESTAMP '${month}-01 00:00:00' + INTERVAL '1' MONTH + INTERVAL '1' DAY

  ), limited AS (SELECT *, count(*) OVER () total_count FROM candidates ORDER BY id,credit_id OFFSET ${page * 400} LIMIT 400)
  SELECT count(*) row_count, coalesce(max(total_count),0) total_count,
    (SELECT CAST(max(created_at) AS varchar) FROM raw_sb_acquisition_analytics.public.vt_attributions
      WHERE created_at <= from_iso8601_timestamp('${asOf}')
        AND created_at >= from_iso8601_timestamp('${asOf}') - INTERVAL '7' DAY) source_updated_at,
    json_format(CAST(array_agg(ARRAY[
    CAST(id AS varchar),CAST(ledger_id AS varchar),CAST(attribution_id AS varchar),client_id,manager,manager_id,attribution_date,captured_at,
    CAST(amount_cents AS varchar),CAST(credit_id AS varchar),CAST(credit_cents AS varchar),CAST(hours AS varchar),CAST(membership_flag AS varchar),payment_method,CAST(parent_credit_id AS varchar)
  ]) AS JSON)) records FROM limited`;
}
