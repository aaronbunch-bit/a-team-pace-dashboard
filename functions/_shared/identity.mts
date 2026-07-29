import type { Context } from "@netlify/functions";

const ALLOWED_EMAIL_DOMAIN = "@varsitytutors.com";

// Verifies the caller's Netlify Identity session by forwarding their Authorization
// bearer token to this site's own GoTrue endpoint (/.netlify/identity/user).
// NOTE: the modern `export default async (req, context)` function signature does
// NOT auto-populate identity on `context` the way the older `clientContext.user`
// pattern did for classic `exports.handler` functions — this is the equivalent
// check for the modern format. Returns the Netlify Identity user object (with
// .email, .app_metadata, .user_metadata) or null if not signed in / invalid token
// / email outside the company domain.
//
// Domain enforcement lives here (and in the login-gate UI) instead of an Identity
// event webhook — identity-validate / userValidate was returning
// "Failed to handle signup webhook" and blocking all Google sign-ups.
export async function getIdentityUser(req: Request, context: Context): Promise<any | null> {
  const authHeader = req.headers.get("authorization") || req.headers.get("Authorization");
  if (!authHeader) return null;

  const siteUrl = context.site?.url || new URL(req.url).origin;
  try {
    const res = await fetch(`${siteUrl.replace(/\/$/, "")}/.netlify/identity/user`, {
      headers: { Authorization: authHeader },
    });
    if (!res.ok) return null;
    const user = await res.json();
    const email = String(user?.email || "").toLowerCase();
    if (!email.endsWith(ALLOWED_EMAIL_DOMAIN)) return null;
    return user;
  } catch {
    return null;
  }
}
