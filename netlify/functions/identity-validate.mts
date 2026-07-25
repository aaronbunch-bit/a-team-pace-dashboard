// Netlify Identity automatically invokes a function named exactly "identity-validate"
// (once Identity is enabled on this site) right before a new signup is finalized.
// Returning a non-2xx response rejects the signup — this is how we enforce
// "@varsitytutors.com accounts only" even with Registration set to Open, since
// Identity's dashboard settings alone don't offer a plain domain-allowlist toggle.
//
// Uses the classic Lambda-compatible handler signature (event, context) rather than
// the modern Request/Context one, since Identity's event-trigger functions
// (identity-signup / identity-login / identity-validate) are documented and wired up
// by Netlify specifically for that older signature — worth double-checking this still
// fires as expected after deploy, since Identity is a more legacy Netlify product.
export const handler = async (event: { body?: string }) => {
  try {
    const payload = JSON.parse(event.body || "{}");
    const email = String(payload?.user?.email || "").toLowerCase();

    if (!email.endsWith("@varsitytutors.com")) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Sign-in is restricted to varsitytutors.com accounts." }),
      };
    }

    return { statusCode: 200, body: JSON.stringify({}) };
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Could not validate signup." }) };
  }
};
