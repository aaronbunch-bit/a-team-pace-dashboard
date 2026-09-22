/**
 * The Starburst (Trino) HTTP protocol, against a stubbed cluster.
 * Run: npm test
 *
 * Trino does not answer a query in one response: the first POST returns a
 * `nextUri`, and rows arrive across however many pages the engine feels like
 * using. A client that reads only the first response returns zero rows from a
 * perfectly healthy query — which on this dashboard looks exactly like "nobody
 * sold anything today". These tests pin the follow loop, the row mapping, and
 * the failure messages an admin has to act on.
 */
import assert from "node:assert/strict";

const realFetch = globalThis.fetch;

/** Serve a scripted list of Trino pages, recording each request. */
function stubCluster(pages) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || "GET", headers: init.headers || {}, body: init.body });
    const page = pages[calls.length - 1];
    if (!page) throw new Error(`unexpected request #${calls.length} to ${url}`);
    return new Response(page.body === undefined ? JSON.stringify(page.json) : page.body, {
      status: page.status || 200,
    });
  };
  return calls;
}

async function withEnv(env, run) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    // Import fresh each time: config is read from env at call time.
    const mod = await import("../functions/_shared/starburst.mts");
    return await run(mod);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    globalThis.fetch = realFetch;
  }
}

const CONNECTED = {
  STARBURST_HOST: "cluster.example.com",
  STARBURST_CATALOG: "hive",
  STARBURST_SCHEMA: "sales_attribution",
  STARBURST_USER: "pacer",
  STARBURST_PASSWORD: "secret",
  STARBURST_TOKEN: undefined,
  STARBURST_PORT: undefined,
  STARBURST_SSL: undefined,
};

// ---- Rows arrive across pages ----------------------------------------------
await withEnv(CONNECTED, async ({ runStarburstSql }) => {
  const calls = stubCluster([
    { json: { id: "q1", nextUri: "https://cluster.example.com/v1/statement/q1/1" } },
    {
      json: {
        id: "q1",
        columns: [{ name: "email" }, { name: "members" }],
        data: [["becky@example.com", 1]],
        nextUri: "https://cluster.example.com/v1/statement/q1/2",
      },
    },
    { json: { id: "q1", data: [["del@example.com", -0.5]] } },
  ]);

  const rows = await runStarburstSql("select 1");
  assert.deepEqual(rows, [
    { email: "becky@example.com", members: 1 },
    { email: "del@example.com", members: -0.5 },
  ], "rows from every page, keyed by column name");
  assert.equal(calls.length, 3, "the client follows nextUri to the end");
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].url, "https://cluster.example.com/v1/statement");
  assert.equal(calls[0].body, "select 1");
  assert.equal(calls[1].method, "GET");
  // Column metadata is latched: page 3 carries data but no columns.
  assert.equal(calls[2].url, "https://cluster.example.com/v1/statement/q1/2");
});

// ---- Auth and routing headers ----------------------------------------------
await withEnv(CONNECTED, async ({ runStarburstSql }) => {
  const calls = stubCluster([{ json: { id: "q1", columns: [{ name: "ok" }], data: [[1]] } }]);
  await runStarburstSql("select 1");
  const headers = calls[0].headers;
  assert.equal(headers["X-Trino-User"], "pacer");
  assert.equal(headers["X-Trino-Catalog"], "hive");
  assert.equal(headers["X-Trino-Schema"], "sales_attribution");
  assert.equal(
    headers.Authorization,
    "Basic " + Buffer.from("pacer:secret").toString("base64"),
    "password auth is sent as HTTP Basic"
  );
});

await withEnv({ ...CONNECTED, STARBURST_PASSWORD: undefined, STARBURST_TOKEN: "jwt-abc" }, async ({ runStarburstSql }) => {
  const calls = stubCluster([{ json: { columns: [{ name: "ok" }], data: [[1]] } }]);
  await runStarburstSql("select 1");
  assert.equal(calls[0].headers.Authorization, "Bearer jwt-abc", "a token cluster gets a bearer");
});

// ---- Failures say what to do about them ------------------------------------
await withEnv(CONNECTED, async ({ runStarburstSql }) => {
  stubCluster([
    {
      json: {
        id: "q1",
        error: { message: "Schema 'sales_attribution' does not exist", errorName: "SCHEMA_NOT_FOUND" },
      },
    },
  ]);
  await assert.rejects(
    runStarburstSql("select 1"),
    /SCHEMA_NOT_FOUND.*does not exist/s,
    "a Trino query error surfaces its name and message"
  );
});

await withEnv(CONNECTED, async ({ runStarburstSql }) => {
  stubCluster([{ status: 401, body: "Unauthorized" }]);
  await assert.rejects(
    runStarburstSql("select 1"),
    /rejected the credentials \(401\).*STARBURST_USER/s,
    "bad credentials name the env vars to check"
  );
});

// A 503 is Trino asking the client to come back, not an outage.
await withEnv(CONNECTED, async ({ runStarburstSql }) => {
  const calls = stubCluster([
    { status: 503, body: "" },
    { json: { columns: [{ name: "ok" }], data: [[1]] } },
  ]);
  assert.deepEqual(await runStarburstSql("select 1"), [{ ok: 1 }]);
  assert.equal(calls.length, 2, "a 503 is retried rather than failing the poll");
});

// ---- Unconfigured is a clear message, not a crash --------------------------
await withEnv(
  { ...CONNECTED, STARBURST_HOST: undefined, STARBURST_CATALOG: undefined },
  async ({ runStarburstSql, starburstMissingEnv, starburstConfig }) => {
    assert.deepEqual(starburstMissingEnv(), ["STARBURST_HOST", "STARBURST_CATALOG"]);
    assert.equal(starburstConfig(), null);
    await assert.rejects(
      runStarburstSql("select 1"),
      /not configured — set STARBURST_HOST, STARBURST_CATALOG/,
      "the error names exactly what is missing"
    );
  }
);

console.log("ok — Starburst page chain, auth headers, retries, and error messages");
