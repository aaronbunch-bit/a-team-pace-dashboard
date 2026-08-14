/**
 * A token nobody signed must not get in.
 * Run: npm test
 *
 * Found by pointing curl at production with a hand-written JWT: header, an email
 * claim, and the literal signature "xxx". It came back 200 with the team's real
 * schedules. `JWT_SECRET` was not set, so the token was decoded but never
 * verified, and the one thing that could have caught it — asking Identity to
 * confirm the token — was wrapped in a catch that treated failure as good enough.
 *
 * `requireAdmin` resolves access from the same email, so a forged token naming
 * the admin address also carried write access: roster, quotas, approvals, ledger
 * exclusions.
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { getIdentityUser } from "../functions/_shared/identity.mts";

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
const future = Math.floor(Date.now() / 1000) + 3600;
const past = Math.floor(Date.now() / 1000) - 3600;

function token(claims, { secret } = {}) {
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64(claims);
  const sig = secret
    ? createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url")
    : "xxx";
  return `${head}.${body}.${sig}`;
}

const req = (jwt) =>
  new Request("https://pacer.test/api/thing", {
    headers: jwt ? { Authorization: `Bearer ${jwt}` } : {},
  });

/** Stand in for Netlify Identity's /user endpoint. */
function withIdentity(handler, run) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return run().finally(() => { globalThis.fetch = original; });
}
const identityDown = () => Promise.reject(new Error("ECONNREFUSED"));
const identityRejects = () => Promise.resolve({ ok: false, status: 401, json: async () => ({}) });
const identityConfirms = (email) => () =>
  Promise.resolve({ ok: true, status: 200, json: async () => ({ email }) });

const SECRET = "identity-jwt-secret";
const REP = { email: "rep@varsitytutors.com", exp: future, sub: "u1" };
const ADMIN = { email: "aaron.bunch@varsitytutors.com", exp: future, sub: "u2" };

delete process.env.JWT_SECRET;
delete process.env.NETLIFY_IDENTITY_JWT_SECRET;

// The reported hole, both ways Identity can decline to vouch.
await withIdentity(identityDown, async () => {
  assert.equal(
    await getIdentityUser(req(token(REP)), {}),
    null,
    "an unsigned token must be refused when Identity cannot confirm it"
  );
});
await withIdentity(identityRejects, async () => {
  assert.equal(
    await getIdentityUser(req(token(ADMIN)), {}),
    null,
    "and naming the admin address must not be a way around it"
  );
});

// Identity vouching for the token is what makes the unsigned path acceptable.
await withIdentity(identityConfirms("rep@varsitytutors.com"), async () => {
  const user = await getIdentityUser(req(token(REP)), {});
  assert.equal(user?.email, "rep@varsitytutors.com", "a session Identity confirms still works");
});

// Identity's answer wins over the token's claim, so a forged email cannot
// impersonate someone else even when the token is otherwise accepted.
await withIdentity(identityConfirms("rep@varsitytutors.com"), async () => {
  const user = await getIdentityUser(req(token(ADMIN)), {});
  assert.equal(
    user?.email,
    "rep@varsitytutors.com",
    "the confirmed identity must override the claimed one"
  );
});

// With the secret set, the signature is checked locally and a bad one is refused
// even if Identity would have vouched.
process.env.JWT_SECRET = SECRET;
await withIdentity(identityConfirms("rep@varsitytutors.com"), async () => {
  assert.equal(
    await getIdentityUser(req(token(REP)), {}),
    null,
    "a forged signature must be refused when JWT_SECRET is set"
  );
});

// A correctly signed token needs no round trip, so Identity being down is fine.
await withIdentity(identityDown, async () => {
  const user = await getIdentityUser(req(token(REP, { secret: SECRET })), {});
  assert.equal(
    user?.email,
    "rep@varsitytutors.com",
    "a signed token works without reaching Identity — this is why JWT_SECRET should be set"
  );
});

// Expiry and domain still hold on the signed path.
await withIdentity(identityDown, async () => {
  assert.equal(
    await getIdentityUser(req(token({ ...REP, exp: past }, { secret: SECRET })), {}),
    null,
    "an expired token is refused"
  );
  assert.equal(
    await getIdentityUser(
      req(token({ email: "outsider@gmail.com", exp: future }, { secret: SECRET })),
      {}
    ),
    null,
    "a signed token from outside the domain is refused"
  );
});

// No token at all stays a clean refusal.
assert.equal(await getIdentityUser(req(null), {}), null, "no Authorization header, no user");

delete process.env.JWT_SECRET;

console.log("ok — unsigned tokens are refused unless Identity confirms them, and signatures win when JWT_SECRET is set");
