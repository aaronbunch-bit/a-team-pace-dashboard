/**
 * SQL the live ledger query is built from, in the grammar of whichever engine
 * is answering it.
 *
 * The pacer's money query is generated, not written by hand: the month key, the
 * credits join and the candidate date columns are all assembled from whatever
 * columns the warehouse turns out to have. That generator was Postgres-only —
 * `::text`, `at time zone`, `left()`, `btrim()`, `interval '1 month'` — so
 * pointing it at Starburst (Trino) produced SQL the engine rejects outright.
 *
 * Every engine-specific fragment now comes from here instead. The Postgres
 * dialect renders byte-for-byte what the generator emitted before, so the
 * Supabase path is unchanged; the Trino dialect is what makes a Starburst
 * connection able to answer the same question.
 */

export type SqlDialectName = "postgres" | "trino";

/** Column type names the month-key probe reasons about, normalized. */
export type NormalizedColumnType = string;

export type SqlDialect = {
  name: SqlDialectName;
  /** Schema-qualified table reference for a `sales_attribution` table. */
  table(name: string): string;
  /** `information_schema` reference (catalog-qualified on Trino). */
  informationSchema(view: "columns" | "tables"): string;
  /** The schema the ledger tables live in, for information_schema predicates. */
  schemaName(): string;
  /** Cast to the engine's string type. */
  text(expr: string): string;
  /** Cast to the engine's 64-bit float. */
  float(expr: string): string;
  /** A NULL typed as the engine's string type. */
  nullText(): string;
  /** Wall-clock timestamp literal resolved in `tz`, as an instant. */
  zonedTimestampLiteral(timestamp: string, tz: string): string;
  /** Read an instant in `tz` and render its calendar day as text. */
  dayTextFromInstant(expr: string, tz: string): string;
  /** Same, for a value stored without a zone (interpreted as local to `tz`). */
  dayTextFromLocal(expr: string, tz: string): string;
  /** Render an instant as text in `tz`. */
  zonedText(expr: string, tz: string): string;
  /** Lift a date-typed column to the instant of its midnight in `tz`. */
  dateToInstant(expr: string, tz: string): string;
  /** Leading `length` characters of `expr` rendered as text. */
  leftText(expr: string, length: number): string;
  /** Strip surrounding whitespace. */
  trim(expr: string): string;
  /** An interval literal, e.g. 1 month or 5 seconds. */
  interval(count: number, unit: "second" | "month"): string;
  /**
   * Engine `data_type` string → the normalized name the month-key probe uses.
   * Trino reports `timestamp(6) with time zone` and `varchar(255)` where
   * Postgres reports `timestamp with time zone` and `character varying`.
   */
  normalizeColumnType(dataType: string): NormalizedColumnType;
};

export type TrinoDialectOptions = {
  /** Trino catalog holding the ledger schema. */
  catalog: string;
  /** Schema inside that catalog (the `sales_attribution` equivalent). */
  schema: string;
};

const POSTGRES_SCHEMA = "sales_attribution";

export const postgresDialect: SqlDialect = {
  name: "postgres",
  table: (name) => `${POSTGRES_SCHEMA}.${name}`,
  informationSchema: (view) => `information_schema.${view}`,
  schemaName: () => POSTGRES_SCHEMA,
  text: (expr) => `${expr}::text`,
  float: (expr) => `${expr}::float8`,
  nullText: () => "null::text",
  zonedTimestampLiteral: (timestamp, tz) => `(timestamp '${timestamp}' at time zone '${tz}')`,
  dayTextFromInstant: (expr, tz) => `(${expr} at time zone '${tz}')::date::text`,
  dayTextFromLocal: (expr, tz) => `(${expr} at time zone '${tz}')::date::text`,
  zonedText: (expr, tz) => `(${expr} at time zone '${tz}')::text`,
  dateToInstant: (expr, tz) => `(${expr}::timestamp at time zone '${tz}')`,
  leftText: (expr, length) => `left((${expr})::text, ${length})`,
  trim: (expr) => `btrim(${expr})`,
  interval: (count, unit) => `interval '${count} ${unit}${count === 1 ? "" : "s"}'`,
  normalizeColumnType: (dataType) => String(dataType || "").trim().toLowerCase(),
};

/**
 * Trino / Starburst.
 *
 * Differences that matter to the generated query, beyond cast syntax:
 *  - `AT TIME ZONE` only applies to a value that already carries a zone, so a
 *    zone-less timestamp has to be lifted with `with_timezone` first.
 *  - Interval literals are `INTERVAL '1' MONTH`, not `interval '1 month'`.
 *  - `information_schema` is per-catalog.
 */
export function trinoDialect({ catalog, schema }: TrinoDialectOptions): SqlDialect {
  const cat = String(catalog || "").trim();
  const sch = String(schema || "").trim();
  if (!cat || !sch) throw new Error("Trino dialect needs both a catalog and a schema");
  const qualified = (name: string) => `${cat}.${sch}.${name}`;
  return {
    name: "trino",
    table: qualified,
    informationSchema: (view) => `${cat}.information_schema.${view}`,
    schemaName: () => sch,
    text: (expr) => `cast(${expr} as varchar)`,
    float: (expr) => `cast(${expr} as double)`,
    nullText: () => "cast(null as varchar)",
    zonedTimestampLiteral: (timestamp, tz) =>
      `with_timezone(timestamp '${timestamp}', '${tz}')`,
    dayTextFromInstant: (expr, tz) => `cast(cast(${expr} at time zone '${tz}' as date) as varchar)`,
    dayTextFromLocal: (expr, tz) =>
      `cast(cast(with_timezone(${expr}, '${tz}') as date) as varchar)`,
    zonedText: (expr, tz) => `cast(${expr} at time zone '${tz}' as varchar)`,
    dateToInstant: (expr, tz) => `with_timezone(cast(${expr} as timestamp), '${tz}')`,
    leftText: (expr, length) => `substr(cast(${expr} as varchar), 1, ${length})`,
    trim: (expr) => `trim(${expr})`,
    interval: (count, unit) => `interval '${count}' ${unit.toUpperCase()}`,
    normalizeColumnType: normalizeTrinoColumnType,
  };
}

/**
 * Trino type name → the Postgres-style name the month-key probe matches on.
 *
 * The probe decides which columns are worth testing as the export's business
 * date by comparing `data_type` against a fixed set. Left untranslated, every
 * Trino column would fail that test and the query would ship with no candidate
 * dates and no credits join.
 */
export function normalizeTrinoColumnType(dataType: string): NormalizedColumnType {
  const raw = String(dataType || "").trim().toLowerCase();
  if (!raw) return raw;
  // Drop precision/scale: `timestamp(6) with time zone` → `timestamp with time zone`.
  const base = raw.replace(/\(\s*\d+\s*(?:,\s*\d+\s*)?\)/g, "");
  if (base === "date") return "date";
  if (base === "timestamp with time zone") return "timestamp with time zone";
  if (base === "timestamp") return "timestamp without time zone";
  if (base === "varchar") return "text";
  if (base === "char") return "character";
  if (base === "double") return "double precision";
  if (base === "decimal") return "numeric";
  return base;
}
