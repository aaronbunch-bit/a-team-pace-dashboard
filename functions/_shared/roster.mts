import { getStore } from "@netlify/blobs";

// Fallback email → display map used only when the goals Blob has never been
// written yet (get-dashboard-data returns null for goals until the first Save
// Goals). Once goals exist on Blobs, that store is the source of truth — the
// Email field on Edit Monthly Goals. Keep this in sync with DEFAULT_GOALS in
// index.html for the pre-first-write window only.
export const FALLBACK_ROSTER_EMAILS: Record<string, string> = {
  "becky.ruffer@varsitytutors.com": "Becky Ruffer",
  "brenda.wong@varsitytutors.com": "Brenda Wong",
  "christopher.jones@varsitytutors.com": "Chris Jones",
  "david.valverde@varsitytutors.com": "David Valverde",
  "del.ali@varsitytutors.com": "Del Ali",
  "domenica.sorrentino@varsitytutors.com": "Domenica Sorrentino",
  "jenna.salupo@varsitytutors.com": "Jenna Salupo",
  "liz.weiss@varsitytutors.com": "Liz Weiss",
  "timothy.carr@varsitytutors.com": "Tim Carr",
};

export const FALLBACK_REP_DISPLAYS = new Set(Object.values(FALLBACK_ROSTER_EMAILS));

/** Resolve a company email to the dashboard display name via goals Blob. */
export async function resolveRepNameFromEmail(email: string): Promise<string | null> {
  const normalized = String(email || "").trim().toLowerCase();
  if (!normalized) return null;

  try {
    const goals = await getStore("goals").get("current", { type: "json" });
    if (goals && typeof goals === "object") {
      for (const [display, g] of Object.entries(goals as Record<string, any>)) {
        const goalEmail = String(g?.email || "").trim().toLowerCase();
        if (goalEmail && goalEmail === normalized) return display;
      }
    }
  } catch {
    // Fall through to the baked-in map.
  }

  return FALLBACK_ROSTER_EMAILS[normalized] || null;
}

/** Active (or all known) rep display names from the roster Blob. */
export async function loadValidRepDisplays(): Promise<Set<string>> {
  try {
    const roster = await getStore("roster").get("current", { type: "json" });
    if (Array.isArray(roster) && roster.length) {
      const names = roster
        .filter((r: any) => r && typeof r.display === "string" && r.display.trim())
        .filter((r: any) => r.active !== false)
        .map((r: any) => String(r.display).trim());
      if (names.length) return new Set(names);
    }
  } catch {
    // Fall through.
  }
  return new Set(FALLBACK_REP_DISPLAYS);
}
