import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

// Deliberately PUBLIC / no auth check, matching the front end's current
// behavior (see the "not-yet-access-restricted" comment above
// renderMasterShoutoutLog() in team-pace-dashboard.html) — shoutout text isn't
// confidential the way payout figures are, and a rep's own Client Detail page
// already shows them their shoutouts with no sign-in required today.
export default async (req: Request, context: Context) => {
  const store = getStore("shoutouts");
  const { blobs } = await store.list();
  const records = (await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" })))).filter(Boolean) as any[];

  // Grouped by recipient rep, newest first per rep — same shape the old
  // SHOUTOUT_LOG_KEY localStorage object used, so the front end's
  // getShoutouts()/shoutoutLogHTML()/renderMasterShoutoutLog() don't need to
  // change how they read this. `hidden` means "keep off the public Shoutout
  // Wall" — the recipient's own log and the admin master log still see it.
  const shoutouts: Record<string, any[]> = {};
  for (const r of records) {
    if (!shoutouts[r.rep]) shoutouts[r.rep] = [];
    shoutouts[r.rep].push({
      id: r.id,
      text: r.text,
      date: r.date,
      from: r.fromDisplayName,
      hidden: !!r.hidden,
      createdAt: r.createdAt,
    });
  }
  Object.keys(shoutouts).forEach((rep) => {
    shoutouts[rep].sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
    shoutouts[rep].forEach((s) => delete s.createdAt);
  });

  return new Response(JSON.stringify({ shoutouts }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

export const config: Config = {
  path: "/api/shoutouts/list",
};
