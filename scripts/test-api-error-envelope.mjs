/**
 * Every read endpoint must answer, even when it fails.
 * Run: npm test
 *
 * The dashboard's read endpoints had no error handling. Anything that threw
 * inside one became an unhandled rejection, and the platform replied with a 500
 * carrying an empty body — which reached the page as a bare "Request failed
 * (500)" with no function name, no reason, and no log line. That is unplaceable
 * from the outside, and placing one took four rounds of guessing.
 *
 * This also guards the mechanical half of that change: the handlers are now
 * wrapped, so a stray brace or paren would leave a function that no longer
 * exports a callable default. Netlify would deploy it and every call would 500 —
 * the exact failure the wrapper exists to prevent.
 */
import assert from "node:assert/strict";
import { withApiErrors } from "../functions/_shared/api-errors.mts";

const req = new Request("https://example.test/api/thing");
const context = {};

// A handler that throws must still produce a readable answer.
{
  const handler = withApiErrors("boom-endpoint", async () => {
    throw new Error("Blobs unavailable");
  });
  const res = await handler(req, context);
  assert.equal(res.status, 502, "a dependency failure is a 502, not a bare platform 500");
  assert.equal(res.headers.get("content-type"), "application/json");
  const body = await res.json();
  assert.match(body.error, /boom-endpoint/, "the body names the function that failed");
  assert.match(body.error, /Blobs unavailable/, "and why it failed");
  assert.equal(body.function, "boom-endpoint");
}

// A thrown non-Error must not become "[object Object]" or an empty message.
{
  const handler = withApiErrors("odd-throw", async () => {
    throw "just a string";
  });
  const body = await (await handler(req, context)).json();
  assert.match(body.error, /just a string/);
}

// A handler that succeeds must pass its own response through untouched.
{
  const handler = withApiErrors("fine-endpoint", async () =>
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json", ETag: '"abc"' },
    })
  );
  const res = await handler(req, context);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("etag"), '"abc"', "response headers survive the wrapper");
  assert.deepEqual(await res.json(), { ok: true });
}

// A 401/403 the handler returns deliberately is an answer, not an error: it must
// keep its own status rather than being rewritten as a 502.
{
  const handler = withApiErrors("gated-endpoint", async () =>
    new Response(JSON.stringify({ error: "Not signed in" }), { status: 401 })
  );
  const res = await handler(req, context);
  assert.equal(res.status, 401, "a handled auth refusal keeps its status");
}

/**
 * Every endpoint the dashboard reads on load still exports a callable default
 * and a route. This is what catches a mis-edited wrapper.
 */
const ENDPOINTS = [
  ["get-dashboard-data", "/api/dashboard/data"],
  ["get-live-actuals", "/api/actuals/live"],
  ["get-team-schedules", "/api/team-schedules"],
  ["get-personal-goals", "/api/personal-goals"],
  ["list-contests", "/api/contests/list"],
  ["list-attributions", "/api/attributions/list"],
  ["get-shoutouts", "/api/shoutouts/list"],
  ["get-badges-data", "/api/badges/data"],
  ["approved-totals", "/api/attributions/approved-totals"],
];

for (const [name, path] of ENDPOINTS) {
  const mod = await import(`../functions/${name}.mts`);
  assert.equal(typeof mod.default, "function", `${name} must export a callable handler`);
  assert.equal(mod.config?.path, path, `${name} must keep serving ${path}`);
}

// Signed out, every one of them must refuse with a status the page can act on —
// never a throw, and never a 500. No Authorization header is sent here, so this
// also proves the wrapper does not swallow the auth gate.
for (const [name] of ENDPOINTS) {
  const mod = await import(`../functions/${name}.mts`);
  const res = await mod.default(new Request(`https://example.test/api/${name}`), {});
  assert.ok(
    res instanceof Response,
    `${name} must return a Response when called without a session`
  );
  assert.ok(
    res.status !== 500,
    `${name} must not answer an unauthenticated call with a bare 500 (got ${res.status})`
  );
}

console.log(
  `ok — failures name themselves, handled statuses survive, and all ${ENDPOINTS.length} read endpoints still export a route`
);
