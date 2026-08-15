import type { Context } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { createHmac, timingSafeEqual } from "node:crypto";

/** Only @varsitytutors.com Google / Identity accounts may call dashboard APIs. */
const ALLOWED_EMAIL_DOMAIN = "@varsitytutors.com";

export type IdentityUser = {
  email: string;
  id?: string;
  app_metadata?: Record<string, unknown>;
  user_metadata?: Record<string, unknown>;
  [key: string]: unknown;
};

function bearerToken(req: Request): string | null {
  const authHeader = req.headers.get("authorization") || req.headers.get("Authorization") || "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

function normalizeEmail(value: unknown): string {
  return String(value || "").trim().toLowerCase();
}

function emailFromPayload(payload: Record<string, any> | null): string {
  if (!payload) return "";
  return normalizeEmail(
    payload.email ||
      payload.user_metadata?.email ||
      payload.app_metadata?.email
  );
}

function isUsableEmail(email: string): boolean {
  return !!email && email.endsWith(ALLOWED_EMAIL_DOMAIN);
}

/**
 * Last address Identity gave for a user id.
 *
 * Not every Identity record carries the address in the token. For those people
 * `emailFromPayload` returns "" and the round trip below is the only thing that
 * can name the caller — so a single blip on that lookup fails a request that a
 * colleague's token answers without touching the network at all. One rep hitting
 * that on every call is indistinguishable, from the outside, from the dashboard
 * being broken for him alone.
 *
 * Remembering the address turns that lookup into an optimisation rather than a
 * dependency. Read on the verified path only — see `getIdentityUser`.
 */
const IDENTITY_EMAIL_STORE = "identity-emails";
/** Per-container memo, so a warm instance never re-reads or re-writes. */
const identityEmailMemo = new Map<string, string>();

function identityEmailKey(id: unknown): string {
  return String(id || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 128);
}

/**
 * `id` MUST be the id Identity itself returned, never the token's `sub`. On the
 * unverified path `sub` is caller-supplied text: keying on it would let anyone
 * holding a real session of their own write their address against someone else's
 * id, and be handed that person's access on the next lookup that blips.
 */
async function rememberIdentityEmail(id: unknown, email: string): Promise<void> {
  const key = identityEmailKey(id);
  if (!key || !isUsableEmail(email)) return;
  if (identityEmailMemo.get(key) === email) return;
  identityEmailMemo.set(key, email);
  try {
    await getStore(IDENTITY_EMAIL_STORE).setJSON(key, {
      email,
      seenAt: new Date().toISOString(),
    });
  } catch {
    // Best effort — the memo still covers the rest of this container's life.
  }
}

async function recallIdentityEmail(sub: unknown): Promise<string> {
  const key = identityEmailKey(sub);
  if (!key) return "";
  const memo = identityEmailMemo.get(key);
  if (memo) return memo;
  try {
    const stored = await getStore(IDENTITY_EMAIL_STORE).get(key, { type: "json" });
    const email = normalizeEmail((stored as Record<string, unknown> | null)?.email);
    if (isUsableEmail(email)) {
      identityEmailMemo.set(key, email);
      return email;
    }
  } catch {
    // Store unavailable — fall through to the refusal in the caller.
  }
  return "";
}

function jwtSecret(): string {
  return String(
    process.env.JWT_SECRET ||
      process.env.NETLIFY_IDENTITY_JWT_SECRET ||
      ""
  ).trim();
}

/** Decode a JWT payload without verifying the signature (legacy fallback). */
function decodeJwtPayload(token: string): Record<string, any> | null {
  try {
    const part = token.split(".")[1];
    if (!part) return null;
    const json = Buffer.from(part, "base64url").toString("utf8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/**
 * Verify Netlify Identity HS256 JWT when JWT_SECRET is configured.
 * Returns null if the signature is invalid / token malformed.
 */
function verifyHs256Jwt(token: string, secret: string): Record<string, any> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [headerB64, payloadB64, sigB64] = parts;
    const expected = createHmac("sha256", secret)
      .update(`${headerB64}.${payloadB64}`)
      .digest("base64url");
    const a = Buffer.from(expected);
    const b = Buffer.from(sigB64);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const json = Buffer.from(payloadB64, "base64url").toString("utf8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function unauthorizedResponse(message?: string): Response {
  return new Response(
    JSON.stringify({
      error: message || "Sign in with your Varsity Tutors Google account required",
    }),
    {
      status: 401,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    }
  );
}

/**
 * Verifies the caller's Netlify Identity session (@varsitytutors.com only).
 *
 * Prefer HMAC verification via JWT_SECRET / NETLIFY_IDENTITY_JWT_SECRET when
 * set. Otherwise validates the token against `/.netlify/identity/user`.
 */
export async function getIdentityUser(req: Request, context: Context): Promise<IdentityUser | null> {
  const token = bearerToken(req);
  if (!token) return null;

  const secret = jwtSecret();
  let payload: Record<string, any> | null = null;
  // Whether the signature was actually checked, or the claims are still just
  // text the caller supplied. Decoding a JWT proves nothing about who sent it.
  let signatureVerified = false;
  if (secret) {
    payload = verifyHs256Jwt(token, secret);
    if (!payload) return null;
    signatureVerified = true;
  } else {
    payload = decodeJwtPayload(token);
    if (!payload) return null;
  }

  if (typeof payload.exp === "number" && payload.exp * 1000 < Date.now()) {
    return null;
  }

  let email = emailFromPayload(payload);
  let user: IdentityUser = {
    email,
    id: payload.sub ? String(payload.sub) : undefined,
    app_metadata: payload.app_metadata || {},
    user_metadata: payload.user_metadata || {},
  };

  const siteUrl = (context.site?.url || new URL(req.url).origin).replace(/\/$/, "");
  // Did Identity itself vouch for this token? Not just enrichment — when the
  // signature was never checked, this is the only thing standing between a
  // forged token and the whole dashboard.
  let identityConfirmed = false;
  try {
    const res = await fetch(`${siteUrl}/.netlify/identity/user`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      const profile = await res.json();
      const profileEmail = normalizeEmail(profile?.email);
      user = {
        ...user,
        ...profile,
        email: profileEmail || email,
      };
      email = normalizeEmail(user.email);
      identityConfirmed = true;
      // Keyed on Identity's own id for the reason spelled out above the helper.
      await rememberIdentityEmail((profile as Record<string, unknown>)?.id, email);
    }
  } catch {
    // Unreachable Identity is handled by the check below, not by trusting the
    // token. This used to swallow the failure and accept the claims as-is.
  }

  // Fail closed on an unverified token.
  //
  // Without JWT_SECRET the signature is not checked, and this call failing was
  // treated as "close enough" — so a hand-written JWT naming any
  // @varsitytutors.com address was accepted as that person. `requireAdmin` reads
  // the same email, so naming the admin address granted write access as well:
  // roster, quotas, approvals, ledger exclusions. Nothing about the request had
  // to come from a real session.
  //
  // Set JWT_SECRET (the Netlify Identity JWT secret) and the signature is
  // verified locally, which is both stricter and cheaper than this round trip.
  if (!signatureVerified && !identityConfirmed) return null;

  // A verified token that carries no address of its own.
  //
  // The signature has already proved which Identity user this is, so `sub` is
  // trustworthy here in a way it never is above. Records without an inline email
  // otherwise depend on the round trip landing every single time — the shape that
  // made the dashboard fail for one person and nobody else.
  //
  // Deliberately only when the payload names no address at all: a token that does
  // name one is answered by that claim (or overridden by Identity), never by this.
  if (signatureVerified && !email) {
    email = await recallIdentityEmail(payload.sub);
    if (email) user.email = email;
  }

  if (!isUsableEmail(email)) return null;
  user.email = email;
  return user;
}

/**
 * Gate for every dashboard API — signed-in @varsitytutors.com Identity user
 * required. Returns either `{ user }` or `{ response }` (401).
 */
export async function requireSignedIn(
  req: Request,
  context: Context
): Promise<{ user: IdentityUser; response?: undefined } | { user?: undefined; response: Response }> {
  const user = await getIdentityUser(req, context);
  if (!user?.email) {
    return { response: unauthorizedResponse() };
  }
  return { user };
}

export { ALLOWED_EMAIL_DOMAIN, unauthorizedResponse };
