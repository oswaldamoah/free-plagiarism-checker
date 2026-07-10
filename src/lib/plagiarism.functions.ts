import { createServerFn } from "@tanstack/react-start";
import { generateText, embedMany, embed } from "ai";
import { z } from "zod";
import { createLovableAiGatewayProvider } from "./ai-gateway.server";

// ---------- schemas ----------
const RankInput = z.object({
  chunks: z
    .array(z.object({ id: z.string(), text: z.string().min(1) }))
    .min(1)
    .max(60),
});

const SearchInput = z.object({
  phrase: z.string().min(3).max(300),
  limit: z.number().int().min(1).max(8).default(5),
});

const SimInput = z.object({
  original: z.string().min(1),
  candidates: z
    .array(z.object({ url: z.string(), title: z.string(), text: z.string() }))
    .min(1)
    .max(10),
});

// ---------- helpers ----------
function getKey() {
  const key = process.env.LOVABLE_API_KEY;
  if (!key) throw new Error("LOVABLE_API_KEY is not configured");
  return key;
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
    const gateway = createLovableAiGatewayProvider(getKey());

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

    const { text } = await generateText({
      model: gateway("google/gemini-3-flash-preview"),
      system,
      prompt: user,
    });

    // Best-effort JSON extraction
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

// ---------- 2. search web (Firecrawl -> DuckDuckGo fallback) ----------
type SearchHit = { url: string; title: string; snippet: string; content: string };

async function searchFirecrawl(phrase: string, limit: number): Promise<SearchHit[] | null> {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) return null;
  try {
    const { default: Firecrawl } = await import("@mendable/firecrawl-js");
    const fc = new Firecrawl({ apiKey });
    const res = await fc.search(phrase, {
      limit,
      scrapeOptions: { formats: ["markdown"] },
    });
    // v2 SDK: results under `web`
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows: any[] = (res as any).web ?? (res as any).data ?? [];
    if (!rows.length) return null;
    return rows.map((r) => ({
      url: r.url ?? "",
      title: r.title ?? r.url ?? "",
      snippet: r.description ?? r.snippet ?? "",
      content: (r.markdown ?? r.description ?? "").slice(0, 4000),
    }));
  } catch (err) {
    console.error("[firecrawl] failed:", err);
    return null;
  }
}

async function searchDuckDuckGo(phrase: string, limit: number): Promise<SearchHit[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(phrase)}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121 Safari/537.36",
    },
  });
  if (!res.ok) return [];
  const html = await res.text();
  const hits: SearchHit[] = [];
  const re =
    /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && hits.length < limit) {
    const rawUrl = decodeURIComponent(
      m[1].replace(/^\/\/duckduckgo\.com\/l\/\?uddg=/, "").split("&")[0],
    );
    const title = m[2].replace(/<[^>]+>/g, "").trim();
    const snippet = m[3].replace(/<[^>]+>/g, "").trim();
    hits.push({ url: rawUrl, title, snippet, content: snippet });
  }
  return hits;
}

export const searchWeb = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => SearchInput.parse(d))
  .handler(async ({ data }) => {
    const fc = await searchFirecrawl(data.phrase, data.limit);
    if (fc && fc.length) return { source: "firecrawl" as const, hits: fc };
    const ddg = await searchDuckDuckGo(data.phrase, data.limit);
    return { source: "duckduckgo" as const, hits: ddg };
  });

// ---------- 3. similarity via embeddings ----------
export const compareSimilarity = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => SimInput.parse(d))
  .handler(async ({ data }) => {
    const gateway = createLovableAiGatewayProvider(getKey());
    const model = gateway.textEmbeddingModel("google/gemini-embedding-001");

    const { embedding: origVec } = await embed({ model, value: data.original });
    const { embeddings: candVecs } = await embedMany({
      model,
      values: data.candidates.map((c) => c.text.slice(0, 4000)),
    });

    return {
      scores: data.candidates.map((c, i) => ({
        url: c.url,
        title: c.title,
        similarity: Math.round(cosine(origVec, candVecs[i]) * 100),
        matchedText: c.text.slice(0, 500),
      })),
    };
  });
