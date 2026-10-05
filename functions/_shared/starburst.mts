import { AsyncLocalStorage } from "node:async_hooks";

const requestSignals = new AsyncLocalStorage<AbortSignal>();
export function withStarburstBudget<T extends (...args: any[]) => Promise<any>>(handler: T): T {
  return ((...args: any[]) => requestSignals.run(AbortSignal.timeout(50_000), () => handler(...args))) as T;
}

/** Server-only Trino client. No browser endpoint accepts arbitrary SQL. */
export type StarburstConfig = { endpoint: string; user: string; password: string; catalog: string };

export function readEnv(name: string): string {
  return String((globalThis as any).Netlify?.env?.get(name) ?? process.env[name] ?? "").trim();
}

export function starburstConfig(): StarburstConfig {
  const endpoint = readEnv("STARBURST_QUERY_URL");
  const user = readEnv("STARBURST_USER");
  const password = readEnv("STARBURST_PASSWORD");
  const catalog = readEnv("STARBURST_ATTRIBUTION_CATALOG");
  if (!endpoint || !user || !password || !catalog) {
    throw new Error("Starburst needs STARBURST_QUERY_URL, STARBURST_USER, STARBURST_PASSWORD and STARBURST_ATTRIBUTION_CATALOG on the server.");
  }
  const url = new URL(endpoint);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !["/", ""].includes(url.pathname)) {
    throw new Error("STARBURST_QUERY_URL must be the HTTPS cluster origin from Starburst connection settings.");
  }
  if (!/^[a-z][a-z0-9_]*$/.test(catalog)) throw new Error("Invalid Starburst attribution catalog.");
  return { endpoint: url.origin, user, password, catalog };
}

/** Retain the existing PostgreSQL ledger semantics through a PostgreSQL catalog.
 * This requires the ORIGINAL sales_attribution schema, not vt_attributions.
 * The Starburst service identity must have read-only database privileges.
 */
export function ledgerPassthroughSql(query: string, catalog: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(catalog)) throw new Error("Invalid Starburst attribution catalog.");
  return `SELECT * FROM TABLE(${catalog}.system.query(query => '${query.replace(/'/g, "''")}'))`;
}

export async function runStarburstSql<T>(query: string, cfg = starburstConfig(), fetcher = fetch): Promise<T[]> {
  const requestSignal = requestSignals.getStore();
  const signal = requestSignal ? AbortSignal.any([requestSignal, AbortSignal.timeout(45_000)]) : AbortSignal.timeout(45_000);
  const headers = {
    Authorization: `Basic ${Buffer.from(`${cfg.user}:${cfg.password}`).toString("base64")}`,
    "X-Trino-User": cfg.user,
    "X-Trino-Source": "a-team-autopacer",
    "Content-Type": "text/plain",
  };
  let next: string | undefined = `${cfg.endpoint}/v1/statement`;
  let first = true;
  let columns: { name: string }[] | undefined;
  const rows: T[] = [];
  let pages = 0;
  try {
    while (next) {
      const url = new URL(next);
      if (url.origin !== cfg.endpoint || !url.pathname.startsWith("/v1/statement") || url.username || url.password) {
        throw new Error("Starburst returned an unexpected result URL.");
      }
      if (++pages > 1000) throw new Error("Starburst result exceeded the page limit.");
      const res = await fetcher(url, {
        method: first ? "POST" : "GET", headers, signal, redirect: "error",
        ...(first ? { body: query } : {}),
      });
      first = false;
      if (!res.ok) {
        throw new Error(res.status === 401 || res.status === 403
          ? "Starburst rejected the server credentials or table access."
          : `Starburst query request failed (${res.status}).`);
      }
      const page = await res.json();
      if (page.error) throw new Error(`Starburst query failed (${page.error.errorName || "QUERY_FAILED"}). Check the configured ledger catalog and permissions.`);
      if (page.columns) columns = page.columns;
      if (page.data?.length && !columns) throw new Error("Starburst returned rows without column definitions.");
      for (const row of page.data || []) {
        if (!Array.isArray(row) || row.length !== columns!.length) throw new Error("Starburst returned an invalid row.");
        rows.push(Object.fromEntries(columns!.map((c, i) => [c.name, row[i]])) as T);
      }
      if (rows.length > 100_000) throw new Error("Starburst result exceeds 100,000 rows; no partial totals were accepted.");
      next = page.nextUri;
      if (next && !page.data?.length) await new Promise(resolve => setTimeout(resolve, 100));
    }
    return rows;
  } catch (error) {
    // Best-effort cancellation of the in-flight query, on the trusted origin only.
    if (next && !first) {
      const url = new URL(next);
      if (url.origin === cfg.endpoint && url.pathname.startsWith("/v1/statement") && !url.username && !url.password) {
        try { await fetcher(url, { method: "DELETE", headers, redirect: "error", signal: AbortSignal.timeout(1000) }); } catch {}
      }
    }
    if (signal.aborted) throw new Error("Starburst took too long; saved actuals remain available.");
    throw error;
  }
}
