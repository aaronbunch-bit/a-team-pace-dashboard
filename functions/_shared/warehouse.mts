/**
 * Which engine answers the pacer's ledger questions.
 *
 * The dashboard read Supabase directly. Starburst is the same data through the
 * warehouse, so the choice is a deployment detail rather than a rewrite: the
 * driver is picked from env here, and every caller asks this module for both
 * the SQL dialect and the connection.
 *
 * Default is unchanged. With no Starburst env set, `auto` resolves to Supabase
 * and the query is byte-identical to what shipped before.
 */

import { runSupabaseSql, supabaseConfig } from "./supabase.mts";
import {
  runStarburstSql,
  starburstConfig,
  starburstMissingEnv,
  STARBURST_REQUIRED_ENV,
} from "./starburst.mts";
import { postgresDialect, trinoDialect, type SqlDialect } from "./sql-dialect.mts";

export type WarehouseDriver = "supabase" | "starburst";

export type WarehouseStatus = {
  driver: WarehouseDriver;
  /** How the driver was chosen: explicit env, or auto-detected. */
  selectedBy: "env" | "auto";
  configured: boolean;
  /** Env vars the active driver still needs. */
  missingEnv: string[];
  /** Human-readable target, never including credentials. */
  target: string;
  dialect: SqlDialect["name"];
  /** Set when WAREHOUSE_DRIVER names something unusable. */
  warning?: string;
};

function env(name: string): string {
  return String(process.env[name] || "").trim();
}

/**
 * Resolve the active driver.
 *
 * `WAREHOUSE_DRIVER=starburst` pins it (so a misconfigured cluster fails loudly
 * instead of silently falling back to Supabase and looking healthy). Unset, the
 * warehouse is used when it is fully configured.
 */
export function resolveWarehouseDriver(): { driver: WarehouseDriver; selectedBy: "env" | "auto"; warning?: string } {
  const requested = env("WAREHOUSE_DRIVER").toLowerCase();
  if (requested === "starburst" || requested === "trino") {
    return { driver: "starburst", selectedBy: "env" };
  }
  if (requested === "supabase") return { driver: "supabase", selectedBy: "env" };
  if (requested) {
    return {
      driver: starburstMissingEnv().length ? "supabase" : "starburst",
      selectedBy: "auto",
      warning: `Unknown WAREHOUSE_DRIVER "${requested}" — ignoring it`,
    };
  }
  return {
    driver: starburstMissingEnv().length ? "supabase" : "starburst",
    selectedBy: "auto",
  };
}

export function warehouseStatus(): WarehouseStatus {
  const { driver, selectedBy, warning } = resolveWarehouseDriver();
  if (driver === "starburst") {
    const cfg = starburstConfig();
    const missingEnv = starburstMissingEnv();
    return {
      driver,
      selectedBy,
      configured: !!cfg,
      missingEnv: missingEnv.length ? missingEnv : cfg ? [] : [...STARBURST_REQUIRED_ENV],
      target: cfg ? `${cfg.baseUrl} · ${cfg.catalog}.${cfg.schema}` : "(not configured)",
      dialect: "trino",
      ...(warning ? { warning } : {}),
    };
  }
  const cfg = supabaseConfig();
  return {
    driver,
    selectedBy,
    configured: !!cfg,
    missingEnv: cfg ? [] : ["SUPABASE_ACCESS_TOKEN"],
    target: cfg ? `supabase:${cfg.projectRef}` : "(not configured)",
    dialect: "postgres",
    ...(warning ? { warning } : {}),
  };
}

/** SQL dialect for the active driver. */
export function warehouseDialect(): SqlDialect {
  const { driver } = resolveWarehouseDriver();
  if (driver !== "starburst") return postgresDialect;
  const cfg = starburstConfig();
  if (!cfg) {
    throw new Error(
      `Starburst is not configured — set ${starburstMissingEnv().join(", ") || "STARBURST_HOST"} in the Netlify site env`
    );
  }
  return trinoDialect({ catalog: cfg.catalog, schema: cfg.schema });
}

export function warehouseConfigured(): boolean {
  return warehouseStatus().configured;
}

/** Run a read-only query against whichever engine is active. */
export async function runWarehouseSql<T = any>(query: string): Promise<T[]> {
  const { driver } = resolveWarehouseDriver();
  if (driver === "starburst") return runStarburstSql<T>(query);
  return runSupabaseSql<T>(query);
}
