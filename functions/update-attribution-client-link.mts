import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { getIdentityUser } from "./_shared/identity.mts";
import { resolveAccess } from "./_shared/access.mts";

/** BUCA / Class Wallet requests often start without a final client page URL. */
export function isBucaAdjustmentReason(reason: unknown): boolean {
  return /buca/i.test(String(reason || ""));
}

function looksLikeUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

// Reps (and full admins) may update the client page link after submitting a
// BUCA / Class Wallet manual attribution — those often need a real client URL
// filled in later. Other reasons stay locked after submit.
export default async (req: Request, context: Context) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
  }

  const user = await getIdentityUser(req, context);
  if (!user?.email) {
    return new Response(JSON.stringify({ error: "Not signed in" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const access = await resolveAccess(user.email);
  if (!access) {
    return new Response(JSON.stringify({ error: "Not signed in" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid request body" }), { status: 400 });
  }

  const id = String(body?.id || "").trim();
  const clientLink = String(body?.clientLink || "").trim();
  if (!id || !clientLink) {
    return new Response(JSON.stringify({ error: "Missing id or clientLink" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (!looksLikeUrl(clientLink)) {
    return new Response(JSON.stringify({ error: "Client page link must be a valid http(s) URL" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const store = getStore("manual-attributions");
  const record: any = await store.get(id, { type: "json" });
  if (!record) {
    return new Response(JSON.stringify({ error: "Request not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!isBucaAdjustmentReason(record.adjustmentReason || record.reason)) {
    return new Response(
      JSON.stringify({ error: "Only BUCA / Class Wallet requests can update the client page after submit" }),
      { status: 403, headers: { "Content-Type": "application/json" } }
    );
  }

  if (record.status === "rejected") {
    return new Response(JSON.stringify({ error: "Rejected requests can't be edited" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  const email = access.email;
  const isOwner = String(record.repEmail || "").toLowerCase() === email;
  if (!isOwner && !access.isFullAdmin) {
    return new Response(JSON.stringify({ error: "You can only edit your own BUCA client page link" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  record.clientLink = clientLink;
  record.clientLinkUpdatedAt = new Date().toISOString();
  record.clientLinkUpdatedBy = email;
  await store.setJSON(id, record);

  return new Response(JSON.stringify({ ok: true, record }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

export const config: Config = {
  path: "/api/attributions/update-client-link",
};
