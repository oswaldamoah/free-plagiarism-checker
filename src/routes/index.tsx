import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { buddyLog, installBuddyLogs } from "../lib/buddy-logs";
import { useServerFn } from "@tanstack/react-start";
import {
  rankPassages,
  searchWeb,
  compareSimilarity,
} from "../lib/plagiarism.functions";
import { extractText, segmentText, countWords, type Chunk } from "../lib/extract";
import { downloadPdf } from "../lib/report-pdf";
import type { Match, ScanReport } from "../lib/types";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  FileText,
  Upload,
  ShieldAlert,
  Download,
  Sparkles,
  Loader2,
  Link as LinkIcon,
} from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Free Plagiarism Checker · AI-assisted web verification" },
      {
        name: "description",
        content:
          "Upload a document or paste text and get an AI-assisted plagiarism report with sources, similarity scores, and a downloadable PDF. No files stored.",
      },
      { property: "og:title", content: "Free Plagiarism Checker" },
      {
        property: "og:description",
        content:
          "AI-filtered passages, web verification, and evidence-based reports. Files processed in memory only.",
      },
    ],
  }),
  component: Home,
});

type Stage = "idle" | "extracting" | "ranking" | "searching" | "comparing" | "done";

function useProgress() {
  const [stage, setStage] = useState<Stage>("idle");
  const [pct, setPct] = useState(0);
  const [msg, setMsg] = useState("");
  return { stage, setStage, pct, setPct, msg, setMsg };
}

function Home() {
  const rank = useServerFn(rankPassages);
  const search = useServerFn(searchWeb);
  const compare = useServerFn(compareSimilarity);

  const [text, setText] = useState("");
  const [filename, setFilename] = useState("pasted-text.txt");
  const [report, setReport] = useState<ScanReport | null>(null);
  const { stage, setStage, pct, setPct, msg, setMsg } = useProgress();

  const busy = stage !== "idle" && stage !== "done";

  useEffect(() => {
    installBuddyLogs();
  }, []);

  const onFile = useCallback(async (file: File) => {
    try {
      setStage("extracting");
      setMsg(`Reading ${file.name}…`);
      setPct(5);
      const t = await extractText(file);
      setText(t);
      setFilename(file.name);
      setStage("idle");
      setMsg("");
      setPct(0);
      toast.success(`Loaded ${file.name} (${countWords(t)} words)`);
    } catch (e) {
      console.error(e);
      toast.error(e instanceof Error ? e.message : "Failed to read file");
      setStage("idle");
    }
  }, [setStage, setMsg, setPct]);

  const analyze = useCallback(async () => {
    if (!text.trim()) {
      toast.error("Add some text or upload a document first.");
      return;
    }
    setReport(null);
    try {
      // 1. Segment
      setStage("extracting");
      setMsg("Segmenting document…");
      setPct(10);
      const chunks: Chunk[] = segmentText(text);
      if (!chunks.length) {
        toast.error("Not enough content to analyze (need paragraphs of 50+ words).");
        setStage("idle");
        return;
      }
      const totalWords = countWords(text);

      // 2. Rank (batched, 30 at a time)
      setStage("ranking");
      setMsg(`AI ranking ${chunks.length} passages…`);
      setPct(25);
      const ranked: Array<{
        id: string;
        priority: number;
        reason: string;
        searchPhrase: string;
        riskType: string;
      }> = [];
      for (let i = 0; i < chunks.length; i += 30) {
        const batch = chunks.slice(i, i + 30);
        const res = await rank({ data: { chunks: batch.map((c) => ({ id: c.id, text: c.text })) } });
        buddyLog("rank", {
          llm: res._meta?.llm,
          batch: `${i}-${i + batch.length}`,
          returned: res.results.length,
        });
        ranked.push(...res.results);
      }

      const chunkById = new Map(chunks.map((c) => [c.id, c]));
      const suspicious = ranked.filter((r) => r.priority >= 70 && r.searchPhrase);

      // 3. Search + compare
      setStage("searching");
      setPct(45);
      const matches: Match[] = [];
      let i = 0;
      for (const r of suspicious) {
        i++;
        setMsg(`Verifying passage ${i}/${suspicious.length} (${r.riskType})…`);
        setPct(45 + Math.round((i / Math.max(suspicious.length, 1)) * 45));
        const chunk = chunkById.get(r.id);
        if (!chunk) continue;
        try {
          const s = await search({ data: { phrase: r.searchPhrase, limit: 5 } });
          const hits = s.hits.filter((h) => h.content && h.content.length > 40);
          if (!hits.length) continue;
          const sim = await compare({
            data: {
              original: chunk.text,
              candidates: hits.map((h) => ({
                url: h.url,
                title: h.title,
                text: h.content,
              })),
            },
          });
          const best = [...sim.scores].sort((a, b) => b.similarity - a.similarity)[0];
          if (best && best.similarity >= 40) {
            matches.push({
              passageId: r.id,
              text: chunk.text,
              similarity: best.similarity,
              riskType: r.riskType,
              matchedText: best.matchedText,
              source: { title: best.title, url: best.url },
            });
          }
        } catch (err) {
          console.error(`[passage ${r.id}] search/compare failed`, err);
        }
      }

      // 4. Compose report
      setStage("comparing");
      setMsg("Compiling report…");
      setPct(95);
      const overall =
        matches.length && totalWords
          ? Math.min(
              100,
              Math.round(
                matches.reduce(
                  (sum, m) => sum + (m.similarity * (chunkById.get(m.passageId)?.wordCount ?? 0)) / totalWords,
                  0,
                ),
              ),
            )
          : 0;

      const r: ScanReport = {
        filename,
        summary: {
          totalWords,
          paragraphsChecked: chunks.length,
          suspiciousPassages: suspicious.length,
          overallSimilarity: overall,
        },
        matches: matches.sort((a, b) => b.similarity - a.similarity),
        createdAt: new Date().toISOString(),
      };
      setReport(r);
      setStage("done");
      setPct(100);
      setMsg("");
      toast.success("Analysis complete");
    } catch (e) {
      console.error(e);
      toast.error(e instanceof Error ? e.message : "Analysis failed");
      setStage("idle");
    }
  }, [text, filename, rank, search, compare, setStage, setMsg, setPct]);

  const wordCount = useMemo(() => countWords(text), [text]);

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-950 to-slate-900 text-slate-100">
      <div className="mx-auto max-w-5xl px-5 py-10">
        <header className="mb-8 flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-sky-500 to-sky-800 shadow-lg shadow-sky-950/50">
            <ShieldAlert className="h-5 w-5 text-white" />
          </div>
          <div>
            <h1 className="text-xl font-semibold">Free Plagiarism Checker</h1>
            <p className="text-xs text-slate-400">
              AI-assisted web verification · files processed in memory, never stored
            </p>
          </div>
        </header>

        <Card className="border-white/5 bg-slate-900/60 backdrop-blur">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <FileText className="h-4 w-4" /> Input
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Tabs defaultValue="paste">
              <TabsList className="bg-slate-800/60">
                <TabsTrigger value="paste">Paste text</TabsTrigger>
                <TabsTrigger value="upload">Upload file</TabsTrigger>
              </TabsList>
              <TabsContent value="paste" className="mt-4">
                <Textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder="Paste the text you want to check…"
                  className="min-h-[220px] resize-y border-white/10 bg-slate-950/60 font-mono text-sm"
                />
              </TabsContent>
              <TabsContent value="upload" className="mt-4">
                <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-white/15 bg-slate-950/40 px-6 py-10 text-center transition hover:border-sky-500/50 hover:bg-slate-950/60">
                  <Upload className="h-6 w-6 text-slate-400" />
                  <div className="text-sm text-slate-300">
                    Click to upload <span className="text-slate-500">.txt · .pdf · .docx</span>
                  </div>
                  <div className="text-xs text-slate-500">Extraction runs in your browser</div>
                  <input
                    type="file"
                    accept=".txt,.pdf,.docx"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) onFile(f);
                    }}
                  />
                </label>
              </TabsContent>
            </Tabs>

            <div className="flex items-center justify-between text-xs text-slate-400">
              <span>{wordCount.toLocaleString()} words · {filename}</span>
              <Button onClick={analyze} disabled={busy || !text.trim()} size="sm">
                {busy ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Analyzing…
                  </>
                ) : (
                  <>
                    <Sparkles className="mr-2 h-4 w-4" /> Check for plagiarism
                  </>
                )}
              </Button>
            </div>

            {busy && (
              <div className="space-y-2">
                <Progress value={pct} className="h-1.5" />
                <p className="text-xs text-slate-400">{msg}</p>
              </div>
            )}
          </CardContent>
        </Card>

        {report && (
          <div className="mt-8 space-y-6">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">Report</h2>
              <Button variant="outline" size="sm" onClick={() => downloadPdf(report)}>
                <Download className="mr-2 h-4 w-4" /> Download PDF
              </Button>
            </div>

            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Stat label="Total Words" value={report.summary.totalWords} />
              <Stat label="Passages Checked" value={report.summary.paragraphsChecked} />
              <Stat label="Suspicious" value={report.summary.suspiciousPassages} />
              <Stat
                label="Overall Similarity"
                value={`${report.summary.overallSimilarity}%`}
                accent={report.summary.overallSimilarity >= 40}
              />
            </div>

            <Card className="border-white/5 bg-slate-900/60">
              <CardHeader>
                <CardTitle className="text-base">Detected Matches</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {report.matches.length === 0 && (
                  <p className="text-sm text-slate-400">
                    No high-similarity matches found. Your text looks clean based on the AI-verified passages.
                  </p>
                )}
                {report.matches.map((m, i) => (
                  <MatchRow key={i} m={m} />
                ))}
              </CardContent>
            </Card>
          </div>
        )}

        <footer className="mt-12 text-center text-xs text-slate-500">
          Uses Lovable AI to prioritize passages and compare embeddings · web search via Firecrawl (DuckDuckGo fallback).
          <br />
          Not a replacement for Turnitin — an assistive verification tool.
        </footer>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string | number;
  accent?: boolean;
}) {
  return (
    <div
      className={`rounded-xl border p-4 ${
        accent ? "border-red-500/30 bg-red-500/10" : "border-white/5 bg-slate-900/60"
      }`}
    >
      <div className="text-xs uppercase tracking-wider text-slate-400">{label}</div>
      <div className={`mt-1 text-2xl font-semibold ${accent ? "text-red-300" : ""}`}>{value}</div>
    </div>
  );
}

function MatchRow({ m }: { m: Match }) {
  const color =
    m.similarity >= 90
      ? "bg-red-500/20 text-red-200 border-red-500/40"
      : m.similarity >= 70
        ? "bg-orange-500/20 text-orange-200 border-orange-500/40"
        : "bg-amber-500/15 text-amber-200 border-amber-500/40";
  return (
    <div className="rounded-lg border border-white/5 bg-slate-950/50 p-4">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Badge variant="outline" className={color}>
          {m.similarity}% similar
        </Badge>
        <Badge variant="outline" className="border-white/10 text-slate-300">
          {m.riskType}
        </Badge>
        <a
          href={m.source.url}
          target="_blank"
          rel="noreferrer"
          className="ml-auto flex items-center gap-1 text-xs text-sky-300 hover:underline"
        >
          <LinkIcon className="h-3 w-3" /> {m.source.title || m.source.url}
        </a>
      </div>
      <p className="text-sm leading-relaxed text-slate-200">{m.text}</p>
      {m.matchedText && (
        <div className="mt-3 rounded border border-white/5 bg-slate-900/60 p-3 text-xs leading-relaxed text-slate-400">
          <div className="mb-1 font-medium text-slate-300">Matched excerpt:</div>
          {m.matchedText}
        </div>
      )}
    </div>
  );
}
