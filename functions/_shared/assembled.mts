/** Assembled WFM API helpers (Basic Auth with API key as username). */

const ASSEMBLED_BASE = "https://api.assembledhq.com/v0";

export function assembledConfig(): { apiKey: string } | null {
  const apiKey = String(process.env.ASSEMBLED_API_KEY || "").trim();
  if (!apiKey) return null;
  return { apiKey };
}

function authHeader(apiKey: string): string {
  // Basic auth: apiKey as username, empty password → base64("key:")
  return "Basic " + Buffer.from(`${apiKey}:`, "utf8").toString("base64");
}

export async function assembledGet<T = any>(
  path: string,
  apiKey: string,
  query?: Record<string, string | number | boolean>
): Promise<T> {
  const url = new URL(ASSEMBLED_BASE + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue;
      url.searchParams.set(k, String(v));
    }
  }
  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Authorization: authHeader(apiKey),
      Accept: "application/json",
      "User-Agent": "a-team-pacer-netlify/1.0",
    },
  });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`Assembled non-JSON (${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    throw new Error(body?.message || body?.error || `Assembled HTTP ${res.status}`);
  }
  return body as T;
}

/** America/Chicago day bounds as Unix seconds (CST/CDT aware via Intl offset). */
export function chicagoDayBoundsUnix(dateStr: string): { start: number; end: number } {
  const [y, m, d] = String(dateStr).slice(0, 10).split("-").map(Number);
  // Find UTC instant for midnight Chicago on that calendar date by probing.
  // Start from UTC noon that day and subtract local offset.
  const utcGuess = Date.UTC(y, m - 1, d, 12, 0, 0);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  // Binary-ish: walk hours until Chicago date matches and hour is 0.
  let startMs = Date.UTC(y, m - 1, d, 5, 0, 0); // CDT midnight ≈ 05:00 UTC; CST ≈ 06:00
  for (let h = 0; h < 48; h++) {
    const t = Date.UTC(y, m - 1, d - 1, h, 0, 0);
    const parts = Object.fromEntries(
      fmt.formatToParts(new Date(t)).filter((p) => p.type !== "literal").map((p) => [p.type, p.value])
    );
    const cy = Number(parts.year);
    const cm = Number(parts.month);
    const cd = Number(parts.day);
    const ch = Number(parts.hour);
    if (cy === y && cm === m && cd === d && ch === 0) {
      startMs = t;
      break;
    }
  }
  void utcGuess;
  const endMs = startMs + 24 * 60 * 60 * 1000;
  return { start: Math.floor(startMs / 1000), end: Math.floor(endMs / 1000) };
}
