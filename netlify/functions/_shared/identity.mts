import type { Context } from "@netlify/functions";

// Verifies the caller's Netlify Identity session by forwarding their Authorization
// bearer token to this site's own GoTrue endpoint (/.netlify/identity/user).
// NOTE: the modern `export default async (req, context)` function signature does
// NOT auto-populate identity on `context` the way the older `clientContext.user`
// pattern did for classic `exports.handler` functions — this is the equivalent
// check for the modern format. Returns the Netlify Identity user object (with
// .email, .app_metadata, .user_metadata) or null if not signed in / invalid token.
export async function getIdentityUser(req: Request, context: Context): Promise<any | null> {
  const authHeader = req.headers.get("authorization") || req.headers.get("Authorization");
  if (!authHeader) return null;

  const siteUrl = context.site?.url || new URL(req.url).origin;
  try {
    const res = await fetch(`${siteUrl.replace(/\/$/, "")}/.netlify/identity/user`, {
      headers: { Authorization: authHeader },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
