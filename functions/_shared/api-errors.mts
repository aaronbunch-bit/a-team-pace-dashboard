import type { Context } from "@netlify/functions";

/**
 * Turn a thrown error into an answer.
 *
 * The dashboard's read endpoints had no error handling at all: a Blobs read that
 * failed, or a stored document that would not parse, became an unhandled
 * rejection, and the platform answered with a 500 carrying an empty body. On the
 * page that surfaced as a bare "Request failed (500)" — no function name, no
 * reason, and nothing written to the function log either. Placing one of those
 * took four rounds of guessing, which is four rounds too many for a dashboard the
 * floor watches all day.
 *
 * Wrapped, every failure names the function that failed and why, in a body the
 * page already knows how to display.
 *
 * The one thing this cannot catch is the module failing to *initialize* — an
 * import that does not resolve throws before any of this code exists. That shows
 * up as a fast 500 with no log on every endpoint at once, which is its own
 * diagnosis: the deploy is bad, not the request.
 */
export function withApiErrors(
  name: string,
  handler: (req: Request, context: Context) => Promise<Response>
) {
  return async (req: Request, context: Context): Promise<Response> => {
    try {
      return await handler(req, context);
    } catch (err: any) {
      console.error(`${name} failed`, err);
      return new Response(
        JSON.stringify({
          error: `${name}: ${String(err?.message || err || "Unknown error")}`,
          function: name,
        }),
        {
          // 502, not 500: the function ran and a dependency it needs let it down.
          // A bare platform 500 means something else entirely, and the two must
          // stay distinguishable from the outside.
          status: 502,
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        }
      );
    }
  };
}
