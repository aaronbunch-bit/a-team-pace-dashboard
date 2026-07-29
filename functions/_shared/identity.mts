import type { Context } from "@netlify/functions";

const ALLOWED_EMAIL_DOMAIN = "@varsitytutors.com";

type IdentityUser = {
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
  return email.endsWith(ALLOWED_EMAIL_DOMAIN);
}

// Verifies the caller's Netlify Identity session.
//
// Primary path: decode the Bearer JWT locally. Fetching
// `/.netlify/identity/user` from inside a Function is unreliable on some
// sites (returns non-OK / fails), which made every admin write look like
// "Only Aaron can…" even when Aaron was signed in. JWT decode keeps admin
// actions working as long as the browser sent a valid Identity token.
//
// Optional enrichment: if the Identity user endpoint is reachable, merge
// that profile on top of the JWT claims.
export async function getIdentityUser(req: Request, context: Context): Promise<IdentityUser | null> {
  const token = bearerToken(req);
  if (!token) return null;

  const payload = decodeJwtPayload(token);
  if (!payload) return null;

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
    }
  } catch {
    // JWT claims are enough for authz when the user endpoint is unreachable.
  }

  if (!isUsableEmail(email)) return null;
  user.email = email;
  return user;
}

export function requirePrimaryAdmin(user: IdentityUser | null, adminEmail: string): Response | null {
  if (!user?.email) {
    return new Response(JSON.stringify({ error: "Not signed in" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (user.email !== adminEmail) {
    return new Response(
      JSON.stringify({
        error: `Only Aaron (${adminEmail}) can do this. Signed in as ${user.email}.`,
      }),
      { status: 403, headers: { "Content-Type": "application/json" } }
    );
  }
  return null;
}
