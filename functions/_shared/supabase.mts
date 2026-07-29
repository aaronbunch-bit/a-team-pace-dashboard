// Server-side Supabase access for the acquisition-call-center project.
// Uses the Management API SQL endpoint with a personal access token
// (SUPABASE_ACCESS_TOKEN) — never expose that token to the browser.

const DEFAULT_PROJECT_REF = "oervjdxjjkhkyledsqag"; // acquisition-call-center-pr

export function supabaseConfig(): { token: string; projectRef: string } | null {
  const token = String(process.env.SUPABASE_ACCESS_TOKEN || "").trim();
  if (!token) return null;
  const projectRef = String(process.env.SUPABASE_PROJECT_REF || DEFAULT_PROJECT_REF).trim();
  return { token, projectRef };
}

/** Run a read-only SQL query against the scoped Supabase project. */
export async function runSupabaseSql<T = any>(query: string): Promise<T[]> {
  const cfg = supabaseConfig();
  if (!cfg) {
    throw new Error("Missing SUPABASE_ACCESS_TOKEN (set it in Netlify env)");
  }

  const res = await fetch(
    `https://api.supabase.com/v1/projects/${cfg.projectRef}/database/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        "Content-Type": "application/json",
        "User-Agent": "a-team-pacer-netlify/1.0",
      },
      body: JSON.stringify({ query }),
    }
  );

  const text = await res.text();
  let body: any;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`Supabase SQL non-JSON response (${res.status}): ${text.slice(0, 200)}`);
  }

  if (!res.ok) {
    const msg =
      (body && (body.message || body.error || body.msg)) ||
      `Supabase SQL failed (${res.status})`;
    throw new Error(String(msg));
  }

  if (Array.isArray(body)) return body as T[];
  if (body && Array.isArray(body.data)) return body.data as T[];
  if (body && Array.isArray(body.result)) return body.result as T[];
  throw new Error("Unexpected Supabase SQL response shape");
}
