import { runSupabaseSql, supabaseConfig } from "./supabase.mts";
import { readEnv, starburstConfig, ledgerPassthroughSql, runStarburstSql } from "./starburst.mts";

export function attributionSource(): "supabase" | "starburst" {
  const source = readEnv("ATTRIBUTION_SOURCE") || "supabase";
  if (source !== "supabase" && source !== "starburst") throw new Error("ATTRIBUTION_SOURCE must be supabase or starburst.");
  return source;
}

export function attributionConfigError(): string | null {
  try {
    if (attributionSource() === "starburst") starburstConfig();
    else if (!supabaseConfig()) return "Set SUPABASE_ACCESS_TOKEN, or configure ATTRIBUTION_SOURCE=starburst and its server connection.";
    return null;
  } catch (e: any) { return e.message; }
}

export function attributionSourceKey(): string {
  return attributionSource() === "starburst"
    ? `starburst:${encodeURIComponent(readEnv("STARBURST_QUERY_URL"))}:${readEnv("STARBURST_ATTRIBUTION_CATALOG")}:${encodeURIComponent(readEnv("STARBURST_USER"))}`
    : "supabase";
}

export async function runAttributionSql<T = any>(query: string): Promise<T[]> {
  if (attributionSource() === "supabase") return runSupabaseSql<T>(query);
  const cfg = starburstConfig();
  return runStarburstSql<T>(ledgerPassthroughSql(query, cfg.catalog), cfg);
}

/** Fail before legacy schema-discovery fallbacks can silently weaken a migration. */
export async function verifyAttributionSource(): Promise<void> {
  if (attributionSource() !== "starburst") return;
  await runAttributionSql(`SELECT l.id, l.attribution_id, l.manager_id, l.credit_id,
    l.net_client_credit_amount, l.hours_amount, l.type, l.created_at, l.deleted_at,
    a.client_id, a.type AS attribution_type, a.occurred_at, a.deleted_at AS attribution_deleted_at,
    f.email, f.name, f.deleted_at AS member_deleted_at, c.occurred_at AS credit_occurred_at
    FROM sales_attribution.rep_scores_ledger_entries l
    JOIN sales_attribution.attributions a ON a.id = l.attribution_id
    JOIN sales_attribution.flex_team_members f ON f.manager_id = l.manager_id
    CROSS JOIN sales_attribution.credits c WHERE FALSE`);
}
