/**
 * Which engine the pacer talks to, and what it says when it cannot.
 * Run: npm test
 *
 * The default has to stay Supabase: a site with no Starburst env set must keep
 * serving live pace exactly as before. Pinning WAREHOUSE_DRIVER=starburst has
 * to fail loudly instead of quietly falling back, because a silent fallback is
 * how a half-finished migration looks healthy while reading the wrong source.
 */
import assert from "node:assert/strict";

const STARBURST_ENV = {
  STARBURST_HOST: "cluster.example.com",
  STARBURST_CATALOG: "hive",
  STARBURST_SCHEMA: "sales_attribution",
};

async function withEnv(env, run) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await run(await import("../functions/_shared/warehouse.mts"));
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const NO_STARBURST = {
  WAREHOUSE_DRIVER: undefined,
  STARBURST_HOST: undefined,
  STARBURST_CATALOG: undefined,
  STARBURST_SCHEMA: undefined,
};

// ---- Default is unchanged --------------------------------------------------
await withEnv({ ...NO_STARBURST, SUPABASE_ACCESS_TOKEN: "pat" }, async ({ warehouseStatus, warehouseDialect }) => {
  const status = warehouseStatus();
  assert.equal(status.driver, "supabase", "no Starburst env means no behaviour change");
  assert.equal(status.selectedBy, "auto");
  assert.equal(status.configured, true);
  assert.equal(status.dialect, "postgres");
  assert.equal(warehouseDialect().name, "postgres");
});

// ---- Fully configured Starburst takes over automatically -------------------
await withEnv({ ...NO_STARBURST, ...STARBURST_ENV }, async ({ warehouseStatus, warehouseDialect }) => {
  const status = warehouseStatus();
  assert.equal(status.driver, "starburst");
  assert.equal(status.configured, true);
  assert.equal(status.dialect, "trino");
  assert.equal(status.target, "https://cluster.example.com · hive.sales_attribution");
  assert.doesNotMatch(JSON.stringify(status), /secret|password|token/i, "status never leaks credentials");
  assert.equal(warehouseDialect().name, "trino");
  assert.equal(warehouseDialect().table("credits"), "hive.sales_attribution.credits");
});

// ---- A half-configured cluster is reported, not guessed at -----------------
await withEnv(
  { ...NO_STARBURST, STARBURST_HOST: "cluster.example.com", WAREHOUSE_DRIVER: "starburst" },
  async ({ warehouseStatus, warehouseDialect }) => {
    const status = warehouseStatus();
    assert.equal(status.driver, "starburst", "an explicit driver is never silently swapped out");
    assert.equal(status.selectedBy, "env");
    assert.equal(status.configured, false);
    assert.deepEqual(status.missingEnv, ["STARBURST_CATALOG", "STARBURST_SCHEMA"]);
    assert.throws(() => warehouseDialect(), /STARBURST_CATALOG, STARBURST_SCHEMA/);
  }
);

// Pinning Supabase keeps Supabase even with a working cluster configured.
await withEnv(
  { ...NO_STARBURST, ...STARBURST_ENV, WAREHOUSE_DRIVER: "supabase", SUPABASE_ACCESS_TOKEN: "pat" },
  async ({ warehouseStatus }) => {
    const status = warehouseStatus();
    assert.equal(status.driver, "supabase");
    assert.equal(status.selectedBy, "env");
  }
);

// A typo must not strand the site on an engine that does not exist.
await withEnv(
  { ...NO_STARBURST, ...STARBURST_ENV, WAREHOUSE_DRIVER: "starbust" },
  async ({ warehouseStatus }) => {
    const status = warehouseStatus();
    assert.equal(status.driver, "starburst", "falls back to detection");
    assert.match(status.warning, /Unknown WAREHOUSE_DRIVER "starbust"/);
  }
);

console.log("ok — driver selection defaults to Supabase, Starburst activates on config, gaps are reported");
