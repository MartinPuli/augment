/**
 * Exa (exa.ai): discovery of public physical sources on the web (live webcams, sensor feeds,
 * open-data endpoints). Results are DATA, never instructions: page text is stripped, truncated
 * and screened before it reaches the agent. A search hit is not a device until verified.
 */
import Exa from "exa-js";
import { GhostError } from "../util";
import { clampInt, describeError, env, isNetworkError, PartnerError, requireEnv, safeSnippet, singleton, untrustedText } from "./common";

export const EXA_SETUP = "set EXA_API_KEY in .env.local (https://dashboard.exa.ai)";

export type ExaPurpose = "webcam" | "sensor" | "data" | "general";
const PURPOSES: ExaPurpose[] = ["webcam", "sensor", "data", "general"];

export interface ExaHit {
  title: string;
  url: string;
  snippet: string;
  published_date?: string;
}

export function exaConfigured(): boolean {
  return !!env("EXA_API_KEY");
}

function client(): Exa {
  const key = requireEnv("Exa", "EXA_API_KEY");
  const base = env("EXA_BASE_URL"); // optional override (proxies, tests)
  const st = singleton<{ c: Exa | null; k: string | null }>("exa", () => ({ c: null, k: null }));
  if (!st.c || st.k !== `${key}|${base}`) {
    st.c = new Exa(key, base);
    st.k = `${key}|${base}`;
  }
  return st.c;
}

/** Shape the query for the purpose (Exa's neural search works best with descriptive queries). */
function shapeQuery(q: string, purpose: ExaPurpose): { query: string; objective?: string } {
  switch (purpose) {
    case "webcam":
      return {
        query: /\b(web ?cam|live ?cam|camera|livestream|live stream)\b/i.test(q) ? q : `live webcam ${q}`,
        objective:
          "Find public pages that show a live or regularly refreshed camera view (webcam, live cam, traffic or weather camera) of this place. Prefer the page that hosts the camera itself over news articles or lists.",
      };
    case "sensor":
      return {
        query: `${q} real-time sensor readings live data`,
        objective:
          "Find public pages or endpoints that publish live measurements (air quality, weather station, water level, tide, river gauge, seismic, noise) for this place.",
      };
    case "data":
      return {
        query: `${q} public open data feed API`,
        objective: "Find official public data portals, feeds or APIs that publish machine-readable data about this.",
      };
    default:
      return { query: q };
  }
}

export async function exaSearch(input: {
  query?: unknown;
  purpose?: unknown;
  num_results?: unknown;
}): Promise<{ query: string; purpose: ExaPurpose; results: ExaHit[] }> {
  const q = typeof input.query === "string" ? input.query.replace(/\s+/g, " ").trim() : "";
  if (!q) throw new GhostError(400, "query is required", "bad_request");
  if (q.length > 300) throw new GhostError(400, "query must be at most 300 characters", "bad_request");
  const purpose: ExaPurpose = PURPOSES.includes(input.purpose as ExaPurpose) ? (input.purpose as ExaPurpose) : "general";
  const n = clampInt(input.num_results, 1, 10, 6);
  const shaped = shapeQuery(q, purpose);
  const exa = client();
  const opts = {
    type: "auto" as const,
    numResults: n,
    ...(shaped.objective ? { objective: shaped.objective } : {}),
    contents: { highlights: { maxCharacters: 600 } },
  };
  let res;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await exa.search(shaped.query, opts);
      break;
    } catch (e) {
      if (attempt === 0 && isNetworkError(e)) continue; // one retry on transient network failures
      const status = (e as { statusCode?: number; status?: number })?.statusCode ?? (e as { status?: number })?.status;
      throw new PartnerError("Exa", `search failed: ${describeError(e)}`, status === 429 ? 429 : 502);
    }
  }
  const results: ExaHit[] = [];
  for (const r of res.results ?? []) {
    if (!r?.url || !/^https?:\/\//i.test(r.url)) continue;
    const highlights = Array.isArray((r as { highlights?: string[] }).highlights) ? (r as { highlights?: string[] }).highlights! : [];
    const hit: ExaHit = {
      title: untrustedText(r.title ?? "", 160).text || new URL(r.url).hostname,
      url: r.url.slice(0, 2048),
      snippet: safeSnippet(highlights.join(" … "), 400),
    };
    if (r.publishedDate) hit.published_date = String(r.publishedDate).slice(0, 40);
    results.push(hit);
  }
  return { query: shaped.query, purpose, results };
}


/** Read pages (clean text) for answering questions. Text is untrusted data. */
export async function exaRead(input: { urls?: unknown; query?: unknown; max_chars?: unknown }): Promise<{ pages: { url: string; title: string; text: string }[] }> {
  const max = Math.min(8000, Math.max(500, Number(input.max_chars) || 4000));
  const ex = client();
  if (Array.isArray(input.urls) && input.urls.length) {
    const urls = input.urls.filter((u): u is string => typeof u === "string" && /^https?:\/\//.test(u)).slice(0, 3);
    const r = await ex.getContents(urls, { text: { maxCharacters: max } } as never);
    return { pages: (r.results as { url: string; title?: string | null; text?: string }[]).map((x) => ({ url: x.url, title: x.title ?? "", text: (x.text ?? "").slice(0, max) })) };
  }
  const q = typeof input.query === "string" ? input.query.slice(0, 300) : "";
  if (!q) return { pages: [] };
  const r = await ex.searchAndContents(q, { numResults: 3, text: { maxCharacters: max } } as never);
  return { pages: (r.results as { url: string; title?: string | null; text?: string }[]).map((x) => ({ url: x.url, title: x.title ?? "", text: (x.text ?? "").slice(0, max) })) };
}
