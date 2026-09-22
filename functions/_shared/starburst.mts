/**
 * Server-side Starburst (Trino) access.
 *
 * Trino's HTTP protocol is not request/response: `POST /v1/statement` returns
 * immediately with a `nextUri`, and the client follows that chain until the
 * engine stops handing one back, collecting `data` pages as it goes. A client
 * that reads only the first response gets an empty result from a perfectly
 * healthy query, so the follow loop below is the protocol, not an optimization.
 *
 * Credentials never reach the browser — this runs in Netlify Functions only.
 */

/** Connection knobs, all from Netlify env. */
export type StarburstConfig = {
  baseUrl: string;
  user: string;
  catalog: string;
  schema: string;
  /** Authorization header value, when the cluster requires one. */
  authorization: string | null;
  /** Session time zone, so `current_date` style functions agree with the pacer. */
  timeZone: string;
};

/** Env vars that must be present before a connection can be attempted. */
export const STARBURST_REQUIRED_ENV = [
  "STARBURST_HOST",
  "STARBURST_CATALOG",
  "STARBURST_SCHEMA",
] as const;

const DEFAULT_TIME_ZONE = "America/Chicago";
const STATEMENT_PATH = "/v1/statement";
/** A page chain that never ends is a bug, not a big result set. */
const MAX_PAGES = 2_000;
const MAX_ROWS = 500_000;
const DEFAULT_TIMEOUT_MS = 55_000;
/** Trino asks clients to back off and retry the page chain on 502/503/504. */
const RETRY_STATUSES = new Set([502, 503, 504]);
const MAX_RETRIES_PER_PAGE = 4;

function env(name: string): string {
  return String(process.env[name] || "").trim();
}

/**
 * Normalize whatever is in `STARBURST_HOST` into an origin.
 *
 * Accepts a bare host (`example.trino.galaxy.starburst.io`), a host:port, or a
 * full URL. Defaults to HTTPS, because password auth over plain HTTP is
 * rejected by Trino anyway.
 */
export function starburstBaseUrl(host: string, port = "", ssl = ""): string {
  const raw = String(host || "").trim().replace(/\/+$/, "");
  if (!raw) return "";
  const insecure = String(ssl || "").trim().toLowerCase() === "false";
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `${insecure ? "http" : "https"}://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return "";
  }
  const explicitPort = String(port || "").trim();
  if (explicitPort && !url.port) url.port = explicitPort;
  return url.origin;
}

/** Which required settings are still missing, for a precise error message. */
export function starburstMissingEnv(): string[] {
  return STARBURST_REQUIRED_ENV.filter((name) => !env(name));
}

export function starburstConfig(): StarburstConfig | null {
  if (starburstMissingEnv().length) return null;

  const baseUrl = starburstBaseUrl(
    env("STARBURST_HOST"),
    env("STARBURST_PORT"),
    env("STARBURST_SSL")
  );
  if (!baseUrl) return null;

  // Galaxy and most self-hosted clusters authenticate with a user/password
  // pair; token clusters (OAuth2 / JWT) send a bearer instead.
  const token = env("STARBURST_TOKEN");
  const user = env("STARBURST_USER") || "lizards-autopacer";
  const password = env("STARBURST_PASSWORD");
  const authorization = token
    ? `Bearer ${token}`
    : password
      ? `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`
      : null;

  return {
    baseUrl,
    user,
    catalog: env("STARBURST_CATALOG"),
    schema: env("STARBURST_SCHEMA"),
    authorization,
    timeZone: env("STARBURST_TIME_ZONE") || DEFAULT_TIME_ZONE,
  };
}

function headersFor(cfg: StarburstConfig, initial: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    "X-Trino-User": cfg.user,
    "X-Trino-Source": "lizards-autopacer-netlify",
    "User-Agent": "lizards-autopacer-netlify/1.0",
    Accept: "application/json",
  };
  if (initial) {
    headers["X-Trino-Catalog"] = cfg.catalog;
    headers["X-Trino-Schema"] = cfg.schema;
    headers["X-Trino-Time-Zone"] = cfg.timeZone;
    headers["Content-Type"] = "text/plain; charset=utf-8";
  }
  if (cfg.authorization) headers.Authorization = cfg.authorization;
  return headers;
}

type TrinoPage = {
  id?: string;
  nextUri?: string;
  columns?: { name: string }[];
  data?: unknown[][];
  error?: {
    message?: string;
    errorName?: string;
    errorCode?: number;
    errorType?: string;
    failureInfo?: { message?: string };
  };
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** One page of the chain, retrying the statuses Trino defines as transient. */
async function fetchPage(
  url: string,
  init: RequestInit,
  signal: AbortSignal
): Promise<TrinoPage> {
  let lastStatus = 0;
  let lastBody = "";
  for (let attempt = 0; attempt <= MAX_RETRIES_PER_PAGE; attempt++) {
    const res = await fetch(url, { ...init, signal });
    const body = await res.text();
    if (RETRY_STATUSES.has(res.status)) {
      lastStatus = res.status;
      lastBody = body;
      // Trino's own clients ramp from 50ms; keep it short so a slow cluster
      // still answers inside the function's budget.
      await sleep(Math.min(50 * 2 ** attempt, 1_000));
      continue;
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `Starburst rejected the credentials (${res.status}). Check STARBURST_USER and STARBURST_PASSWORD/STARBURST_TOKEN.`
      );
    }
    if (!res.ok) {
      throw new Error(`Starburst HTTP ${res.status}: ${body.slice(0, 300)}`);
    }
    try {
      return body ? (JSON.parse(body) as TrinoPage) : {};
    } catch {
      throw new Error(`Starburst non-JSON response: ${body.slice(0, 200)}`);
    }
  }
  throw new Error(
    `Starburst still unavailable after ${MAX_RETRIES_PER_PAGE} retries (HTTP ${lastStatus}): ${lastBody.slice(0, 200)}`
  );
}

function trinoErrorMessage(error: NonNullable<TrinoPage["error"]>): string {
  const detail = error.message || error.failureInfo?.message || "query failed";
  const name = error.errorName ? ` [${error.errorName}]` : "";
  return `Starburst query failed${name}: ${detail}`;
}

/**
 * Run a read-only query against Starburst and return rows as objects.
 *
 * Column names come from the first page that carries them; Trino may send data
 * pages before or after that, so names are latched rather than read per page.
 */
export async function runStarburstSql<T = any>(
  query: string,
  opts: { timeoutMs?: number } = {}
): Promise<T[]> {
  const cfg = starburstConfig();
  if (!cfg) {
    const missing = starburstMissingEnv();
    throw new Error(
      missing.length
        ? `Starburst is not configured — set ${missing.join(", ")} in the Netlify site env`
        : "Starburst host is not a valid URL — check STARBURST_HOST"
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    let page = await fetchPage(
      `${cfg.baseUrl}${STATEMENT_PATH}`,
      { method: "POST", headers: headersFor(cfg, true), body: query },
      controller.signal
    );

    let columns: string[] = [];
    const rows: T[] = [];
    let pages = 0;

    for (;;) {
      if (page.error) throw new Error(trinoErrorMessage(page.error));
      if (!columns.length && Array.isArray(page.columns) && page.columns.length) {
        columns = page.columns.map((c) => String(c?.name || ""));
      }
      if (Array.isArray(page.data) && page.data.length) {
        if (!columns.length) {
          throw new Error("Starburst returned data before any column metadata");
        }
        for (const values of page.data) {
          const row: Record<string, unknown> = {};
          for (let i = 0; i < columns.length; i++) row[columns[i]] = values[i];
          rows.push(row as T);
          if (rows.length > MAX_ROWS) {
            throw new Error(`Starburst returned more than ${MAX_ROWS} rows — refusing to buffer`);
          }
        }
      }
      if (!page.nextUri) return rows;
      if (++pages > MAX_PAGES) {
        throw new Error(`Starburst paged past ${MAX_PAGES} responses without finishing`);
      }
      page = await fetchPage(
        page.nextUri,
        { method: "GET", headers: headersFor(cfg, false) },
        controller.signal
      );
    }
  } catch (err: any) {
    if (err?.name === "AbortError") {
      throw new Error("Starburst query timed out");
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}
