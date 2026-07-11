import { createServerFn } from "@tanstack/react-start";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, embedMany, embed } from "ai";
import { z } from "zod";
import { createGeminiAiGatewayProvider } from "./ai-gateway.server";

// ---------- schemas ----------
const LlmPref = z.enum(["auto", "deepseek", "gemini"]).default("auto");
const SearchPref = z
  .enum(["auto", "firecrawl", "duckduckgo", "wikipedia"])
  .default("auto");

const RankInput = z.object({
  chunks: z
    .array(z.object({ id: z.string(), text: z.string().min(1) }))
    .min(1)
    .max(60),
  llm: LlmPref.optional(),
});

const SearchInput = z.object({
  phrase: z.string().min(3).max(300),
  limit: z.number().int().min(1).max(8).default(5),
  search: SearchPref.optional(),
});

const SimInput = z.object({
  original: z.string().min(1),
  candidates: z
    .array(z.object({ url: z.string(), title: z.string(), text: z.string() }))
    .min(1)
    .max(10),
});

// ---------- helpers ----------
function getGeminiKey() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not configured");
  return key;
}

function getOpenRouterProvider() {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return null;
  return createOpenAICompatible({
    name: "openrouter",
    baseURL: "https://openrouter.ai/api/v1",
    headers: {
      Authorization: `Bearer ${key}`,
      "HTTP-Referer": "https://lovable.dev",
      "X-Title": "Free Plagiarism Checker",
    },
  });
}

const DEEPSEEK_MODEL = "deepseek/deepseek-chat-v3.1";
const GEMINI_MODEL = "google/gemini-3-flash-preview";

async function runDeepseek(system: string, prompt: string) {
  const or = getOpenRouterProvider();
  if (!or) throw new Error("no OPENROUTER_API_KEY");
  const { text } = await generateText({
    model: or(DEEPSEEK_MODEL),
    system,
    prompt,
  });
  if (!text || !text.trim()) throw new Error("empty response");
  return text;
}

async function runGemini(system: string, prompt: string) {
  const gateway = createGeminiAiGatewayProvider(getGeminiKey());
  const { text } = await generateText({
    model: gateway(GEMINI_MODEL),
    system,
    prompt,
  });
  return text;
}

/**
 * pref="auto"     -> DeepSeek first, fallback Gemini
 * pref="deepseek" -> DeepSeek only, fallback Gemini on hard error
 * pref="gemini"   -> Gemini only
 */
async function generateWithPref(args: {
  system: string;
  prompt: string;
  pref: "auto" | "deepseek" | "gemini";
}): Promise<{ text: string; provider: "deepseek/openrouter" | "gemini"; fallback: boolean; note?: string }> {
  const errors: string[] = [];

  if (args.pref === "gemini") {
    const text = await runGemini(args.system, args.prompt);
    return { text, provider: "gemini", fallback: false };
  }

  // auto or deepseek -> try DeepSeek first
  try {
    const text = await runDeepseek(args.system, args.prompt);
    return { text, provider: "deepseek/openrouter", fallback: false };
  } catch (e) {
    errors.push(`deepseek: ${e instanceof Error ? e.message : String(e)}`);
  }

  // fallback to Gemini
  try {
    const text = await runGemini(args.system, args.prompt);
    return {
      text,
      provider: "gemini",
      fallback: true,
      note: errors.join(" | "),
    };
  } catch (e) {
    errors.push(`gemini: ${e instanceof Error ? e.message : String(e)}`);
    throw new Error(`All LLM providers failed. ${errors.join(" | ")}`);
  }
}

function cosine(a: number[], b: number[]) {
  let dot = 0,
    na = 0,
    nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

// ---------- 1. rank passages (batched) ----------
export const rankPassages = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => RankInput.parse(d))
  .handler(async ({ data }) => {
    const system = `You are inside a plagiarism verification system. You do NOT decide plagiarism. You only identify which passages are most valuable to verify against online sources.

High priority: statistics, uncommon wording, technical explanations, definitions, quotes, unique claims, specific facts.
Low priority: generic intros, common academic phrases, conclusions, transitions.

Return ONLY valid JSON, no markdown fences, no commentary.`;

    const user = `For each paragraph below, return an object with:
- id: the paragraph id
- plagiarism_search_priority: 0-100
- reason: short explanation
- search_phrase: shortest unique phrase (5-12 words) likely to find the source, or "" if not worth searching
- risk_type: one of statistic | quote | definition | technical | unique_claim | generic

Return JSON of shape: { "results": [ ... ] }.

Paragraphs:
${data.chunks.map((c) => `[${c.id}] ${c.text}`).join("\n\n")}`;

    const pref = data.llm ?? "auto";
    const { text, provider, fallback, note } = await generateWithPref({
      system,
      prompt: user,
      pref,
    });

    const jsonStr = text.match(/\{[\s\S]*\}/)?.[0] ?? text;
    let parsed: {
      results?: Array<{
        id: string;
        plagiarism_search_priority: number;
        reason: string;
        search_phrase: string;
        risk_type: string;
      }>;
    } = {};
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      parsed = { results: [] };
    }

    const map = new Map(parsed.results?.map((r) => [r.id, r]) ?? []);
    return {
      _meta: { llm: provider, fallback, note, pref },
      results: data.chunks.map((c) => {
        const r = map.get(c.id);
        return {
          id: c.id,
          priority: r?.plagiarism_search_priority ?? 0,
          reason: r?.reason ?? "",
          searchPhrase: r?.search_phrase ?? "",
          riskType: r?.risk_type ?? "generic",
        };
      }),
    };
  });

// ---------- 2. search web (DuckDuckGo -> Firecrawl -> Wikipedia fallback) ----------
type SearchHit = { url: string; title: string; snippet: string; content: string };

/** Timeout in ms for individual HTTP fetches (search engines & page scraping). */
const FETCH_TIMEOUT_MS = 8_000;

function decodeHtmlEntities(input: string) {
  return input
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/g, "/");
}

function stripHtml(input: string) {
  return decodeHtmlEntities(
    input
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

/** Fetch a page and extract its visible text. Has a hard timeout so it never hangs. */
async function fetchPageText(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121 Safari/537.36",
      },
    });
    if (!res.ok) return "";
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
      return "";
    }
    const html = await res.text();
    return stripHtml(html).slice(0, 6000);
  } catch {
    return "";
  }
}

/**
 * For each hit whose content is short (< 500 chars), try to fetch the full page text.
 * Uses Promise.allSettled so one slow/failing page can't block the rest.
 */
async function enrichSearchHits(hits: SearchHit[]): Promise<SearchHit[]> {
  const results = await Promise.allSettled(
    hits.map(async (hit) => {
      if (hit.content && hit.content.length >= 500) return hit;
      const pageText = await fetchPageText(hit.url);
      const content = [hit.snippet, pageText].filter(Boolean).join("\n\n").trim();
      return { ...hit, content: content || hit.content };
    }),
  );
  return results.map((r, i) => (r.status === "fulfilled" ? r.value : hits[i]));
}

// ---- DuckDuckGo (primary — free, no API key, proven reliable) ----

async function searchDuckDuckGo(phrase: string, limit: number): Promise<SearchHit[]> {
  console.log("[ddg] searching:", phrase);
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(phrase)}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121 Safari/537.36",
      },
    });
    if (!res.ok) {
      console.error("[ddg] http error:", res.status);
      return [];
    }
    const html = await res.text();
    const hits: SearchHit[] = [];
    const re =
      /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) && hits.length < limit) {
      const rawUrl = decodeURIComponent(
        m[1].replace(/^\/\/duckduckgo\.com\/l\/\?uddg=/, "").split("&")[0],
      );
      const title = stripHtml(m[2]);
      const snippet = stripHtml(m[3]);
      if (rawUrl && title) {
        hits.push({ url: rawUrl, title, snippet, content: snippet });
      }
    }
    console.log(`[ddg] found ${hits.length} hits`);
    // Enrich with full page text (best-effort, non-blocking)
    return hits.length > 0 ? await enrichSearchHits(hits) : hits;
  } catch (err) {
    console.error("[ddg] failed:", err instanceof Error ? err.message : String(err));
    return [];
  }
}

// ---- Firecrawl (optional premium — needs FIRECRAWL_API_KEY) ----

async function searchFirecrawl(
  phrase: string,
  limit: number,
): Promise<{ hits: SearchHit[]; error?: string } | null> {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) return null;
  console.log("[firecrawl] searching:", phrase);
  try {
    const { default: Firecrawl } = await import("@mendable/firecrawl-js");
    const fc = new Firecrawl({ apiKey });
    const res = await fc.search(phrase, {
      limit,
      scrapeOptions: { formats: ["markdown"] },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows: any[] = (res as any).web ?? (res as any).data ?? [];
    if (!rows.length) {
      console.log("[firecrawl] no results");
      return { hits: [] };
    }
    const hits = rows.map((r) => ({
      url: r.url ?? "",
      title: r.title ?? r.url ?? "",
      snippet: r.description ?? r.snippet ?? "",
      content: (r.markdown ?? r.description ?? "").slice(0, 4000),
    }));
    console.log(`[firecrawl] found ${hits.length} hits`);
    return { hits };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[firecrawl] failed:", msg);
    return { hits: [], error: msg };
  }
}

// ---- Wikipedia (free fallback — great for definitions and encyclopaedic claims) ----

async function searchWikipedia(phrase: string, limit: number): Promise<SearchHit[]> {
  console.log("[wikipedia] searching:", phrase);
  try {
    const url = `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(
      phrase,
    )}&limit=${limit}&namespace=0&format=json`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      console.error("[wikipedia] http error:", res.status);
      return [];
    }
    const data = (await res.json()) as [string, string[], string[], string[]];
    const titles = data?.[1] ?? [];
    const snippets = data?.[2] ?? [];
    const urls = data?.[3] ?? [];
    const hits: SearchHit[] = [];
    for (let i = 0; i < Math.min(titles.length, urls.length, limit); i++) {
      const snippet = (snippets[i] ?? "").trim();
      hits.push({
        url: urls[i],
        title: titles[i],
        snippet,
        content: snippet,
      });
    }
    console.log(`[wikipedia] found ${hits.length} hits`);
    // Enrich Wikipedia hits with full article text (they're reliable & fast)
    return hits.length > 0 ? await enrichSearchHits(hits) : hits;
  } catch (err) {
    console.error("[wikipedia] failed:", err instanceof Error ? err.message : String(err));
    return [];
  }
}

// ---- Orchestrator: search hierarchy ----
// Auto order: DuckDuckGo (free, reliable) → Firecrawl (paid, if key) → Wikipedia (free fallback)

export const searchWeb = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => SearchInput.parse(d))
  .handler(async ({ data }) => {
    const pref = data.search ?? "auto";
    console.log(`[searchWeb] pref=${pref} phrase="${data.phrase.slice(0, 60)}"`);

    // ---------- explicit provider selection ----------
    if (pref === "duckduckgo") {
      const ddg = await searchDuckDuckGo(data.phrase, data.limit);
      return { _meta: { search: "duckduckgo" as const, fallback: false, pref }, hits: ddg };
    }

    if (pref === "firecrawl") {
      const fc = await searchFirecrawl(data.phrase, data.limit);
      return {
        _meta: {
          search: "firecrawl" as const,
          fallback: false,
          pref,
          firecrawlError: fc?.error ?? (fc === null ? "no_api_key" : undefined),
        },
        hits: fc?.hits ?? [],
      };
    }

    if (pref === "wikipedia") {
      const wiki = await searchWikipedia(data.phrase, data.limit);
      return { _meta: { search: "wikipedia" as const, fallback: false, pref }, hits: wiki };
    }

    // ---------- auto: DuckDuckGo → Firecrawl → Wikipedia ----------
    const errors: Record<string, string> = {};

    // 1. DuckDuckGo (primary)
    try {
      const ddg = await searchDuckDuckGo(data.phrase, data.limit);
      if (ddg.length > 0) {
        return { _meta: { search: "duckduckgo" as const, fallback: false, pref }, hits: ddg };
      }
      errors.duckduckgo = "no_results";
    } catch (e) {
      errors.duckduckgo = e instanceof Error ? e.message : String(e);
    }

    // 2. Firecrawl (if API key available)
    try {
      const fc = await searchFirecrawl(data.phrase, data.limit);
      if (fc && fc.hits.length > 0 && !fc.error) {
        return {
          _meta: { search: "firecrawl" as const, fallback: true, pref, ...errors },
          hits: fc.hits,
        };
      }
      if (fc) errors.firecrawl = fc.error ?? "no_results";
      else errors.firecrawl = "no_api_key";
    } catch (e) {
      errors.firecrawl = e instanceof Error ? e.message : String(e);
    }

    // 3. Wikipedia (last resort)
    try {
      const wiki = await searchWikipedia(data.phrase, data.limit);
      return {
        _meta: { search: "wikipedia" as const, fallback: true, pref, ...errors },
        hits: wiki,
      };
    } catch (e) {
      errors.wikipedia = e instanceof Error ? e.message : String(e);
    }

    // All failed
    console.error("[searchWeb] all providers failed:", errors);
    return { _meta: { search: "none" as const, fallback: true, pref, ...errors }, hits: [] };
  });

// ---------- 3. similarity via embeddings (Gemini) ----------
export const compareSimilarity = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => SimInput.parse(d))
  .handler(async ({ data }) => {
    const gateway = createGeminiAiGatewayProvider(getGeminiKey());
    const model = gateway.textEmbeddingModel("google/gemini-embedding-001");

    const { embedding: origVec } = await embed({ model, value: data.original });
    const { embeddings: candVecs } = await embedMany({
      model,
      values: data.candidates.map((c) => c.text.slice(0, 4000)),
    });

    return {
      _meta: { embeddings: "gemini" as const },
      scores: data.candidates.map((c, i) => ({
        url: c.url,
        title: c.title,
        similarity: Math.round(cosine(origVec, candVecs[i]) * 100),
        matchedText: c.text.slice(0, 500),
      })),
    };
  });
