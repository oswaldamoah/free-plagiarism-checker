import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  buddyLog,
  installBuddyLogs,
  subscribeBuddyLogs,
  clearBuddyLogs,
  type BuddyEntry,
} from "../lib/buddy-logs";
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
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  FileText,
  Upload,
  ShieldAlert,
  Download,
  Sparkles,
  Loader2,
  Link as LinkIcon,
  Settings,
  Terminal,
  Sun,
  Moon,
  Trash2,
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
type LlmPref = "auto" | "deepseek" | "gemini";
type SearchPref = "auto" | "firecrawl" | "duckduckgo";
type ThemePref = "dark" | "light";

const PREFS_KEY = "fpc-prefs-v1";

type Prefs = { llm: LlmPref; search: SearchPref; theme: ThemePref };
const DEFAULT_PREFS: Prefs = { llm: "auto", search: "auto", theme: "dark" };

function loadPrefs(): Prefs {
  if (typeof window === "undefined") return DEFAULT_PREFS;
  try {
    const raw = window.localStorage.getItem(PREFS_KEY);
    if (!raw) return DEFAULT_PREFS;
    return { ...DEFAULT_PREFS, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_PREFS;
  }
}

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

  const [prefs, setPrefsState] = useState<Prefs>(DEFAULT_PREFS);
  const [logs, setLogs] = useState<BuddyEntry[]>([]);
  const [mounted, setMounted] = useState(false);

  const busy = stage !== "idle" && stage !== "done";

  // Hydrate prefs on client only (avoid SSR mismatch)
  useEffect(() => {
    setPrefsState(loadPrefs());
    setMounted(true);
    installBuddyLogs();
    const unsub = subscribeBuddyLogs(setLogs);
    return () => unsub();
  }, []);

  const setPrefs = useCallback((next: Partial<Prefs>) => {
    setPrefsState((cur) => {
      const merged = { ...cur, ...next };
      try {
        window.localStorage.setItem(PREFS_KEY, JSON.stringify(merged));
      } catch {
        /* ignore */
      }
      return merged;
    });
  }, []);

  const isDark = prefs.theme === "dark";

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
    buddyLog("info", { event: "analysis_start", llmPref: prefs.llm, searchPref: prefs.search });
    try {
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
        const res = await rank({
          data: {
            chunks: batch.map((c) => ({ id: c.id, text: c.text })),
            llm: prefs.llm,
          },
        });
        buddyLog("rank", {
          llm: res._meta?.llm,
          fallback: res._meta?.fallback,
          pref: res._meta?.pref,
          note: res._meta?.note,
          batch: `${i}-${i + batch.length}`,
          returned: res.results.length,
        });
        ranked.push(...res.results);
      }

      const chunkById = new Map(chunks.map((c) => [c.id, c]));
      const suspicious = ranked.filter((r) => r.priority >= 70 && r.searchPhrase);

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
          const s = await search({
            data: { phrase: r.searchPhrase, limit: 5, search: prefs.search },
          });
          buddyLog("search", {
            passage: r.id,
            phrase: r.searchPhrase,
            search: s._meta?.search,
            fallback: s._meta?.fallback,
            pref: s._meta?.pref,
            firecrawlError: s._meta?.firecrawlError,
            hits: s.hits.length,
          });
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
          buddyLog("similarity", {
            passage: r.id,
            embeddings: sim._meta?.embeddings,
            top: best ? `${best.similarity}%` : "n/a",
            source: best?.url,
          });
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
          buddyLog("error", { passage: r.id, err: err instanceof Error ? err.message : String(err) });
          console.error(`[passage ${r.id}] search/compare failed`, err);
        }
      }

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
  }, [text, filename, rank, search, compare, prefs.llm, prefs.search, setStage, setMsg, setPct]);

  const wordCount = useMemo(() => countWords(text), [text]);

  // Theme classes
  const rootBg = isDark
    ? "bg-gradient-to-b from-slate-950 to-slate-900 text-slate-100"
    : "bg-gradient-to-b from-slate-50 to-white text-slate-900";
  const cardBg = isDark ? "border-white/5 bg-slate-900/60 backdrop-blur" : "border-slate-200 bg-white";
  const subText = isDark ? "text-slate-400" : "text-slate-500";
  const mutedBg = isDark ? "bg-slate-800/60" : "bg-slate-100";
  const inputBg = isDark ? "border-white/10 bg-slate-950/60" : "border-slate-200 bg-white";
  const dashedBg = isDark
    ? "border-white/15 bg-slate-950/40 hover:border-sky-500/50 hover:bg-slate-950/60"
    : "border-slate-300 bg-slate-50 hover:border-sky-500/70 hover:bg-slate-100";
  const statBg = isDark ? "border-white/5 bg-slate-900/60" : "border-slate-200 bg-white";
  const matchBg = isDark ? "border-white/5 bg-slate-950/50" : "border-slate-200 bg-slate-50";
  const excerptBg = isDark ? "border-white/5 bg-slate-900/60 text-slate-400" : "border-slate-200 bg-white text-slate-600";
  const footerText = isDark ? "text-slate-500" : "text-slate-500";

  // Provider chips in header
  const lastLlm = [...logs].reverse().find((l) => l.kind === "rank")?.detail.llm as string | undefined;
  const lastSearch = [...logs].reverse().find((l) => l.kind === "search")?.detail.search as
    | string
    | undefined;

  return (
    <div className={`min-h-screen ${rootBg}`}>
      <div className="mx-auto max-w-5xl px-5 py-10">
        <header className="mb-8 flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-sky-500 to-sky-800 shadow-lg shadow-sky-950/50">
            <ShieldAlert className="h-5 w-5 text-white" />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-semibold">Free Plagiarism Checker</h1>
            <p className={`text-xs ${subText}`}>
              AI-assisted web verification · files processed in memory
            </p>
          </div>

          {mounted && (
            <div className="flex items-center gap-2">
              <SettingsPopover prefs={prefs} setPrefs={setPrefs} />
              <LogsSheet logs={logs} />
            </div>
          )}
        </header>

        {/* live provider chips */}
        {mounted && (lastLlm || lastSearch) && (
          <div className="mb-4 flex flex-wrap items-center gap-2 text-xs">
            {lastLlm && (
              <Badge variant="outline" className={isDark ? "border-white/10 text-slate-300" : ""}>
                LLM: {lastLlm}
              </Badge>
            )}
            {lastSearch && (
              <Badge variant="outline" className={isDark ? "border-white/10 text-slate-300" : ""}>
                Search: {lastSearch}
              </Badge>
            )}
          </div>
        )}

        <Card className={cardBg}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <FileText className="h-4 w-4" /> Input
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Tabs defaultValue="paste">
              <TabsList className={mutedBg}>
                <TabsTrigger value="paste">Paste text</TabsTrigger>
                <TabsTrigger value="upload">Upload file</TabsTrigger>
              </TabsList>
              <TabsContent value="paste" className="mt-4">
                <Textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder="Paste the text you want to check…"
                  className={`min-h-[220px] resize-y font-mono text-sm ${inputBg}`}
                />
              </TabsContent>
              <TabsContent value="upload" className="mt-4">
                <label
                  className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed px-6 py-10 text-center transition ${dashedBg}`}
                >
                  <Upload className={`h-6 w-6 ${subText}`} />
                  <div className="text-sm">
                    Click to upload <span className={subText}>.txt · .pdf · .docx</span>
                  </div>
                  <div className={`text-xs ${subText}`}>Extraction runs in your browser</div>
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

            <div className={`flex items-center justify-between text-xs ${subText}`}>
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
                <p className={`text-xs ${subText}`}>{msg}</p>
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
              <Stat label="Total Words" value={report.summary.totalWords} bg={statBg} sub={subText} />
              <Stat label="Passages Checked" value={report.summary.paragraphsChecked} bg={statBg} sub={subText} />
              <Stat label="Suspicious" value={report.summary.suspiciousPassages} bg={statBg} sub={subText} />
              <Stat
                label="Overall Similarity"
                value={`${report.summary.overallSimilarity}%`}
                accent={report.summary.overallSimilarity >= 40}
                bg={statBg}
                sub={subText}
              />
            </div>

            <Card className={cardBg}>
              <CardHeader>
                <CardTitle className="text-base">Detected Matches</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {report.matches.length === 0 && (
                  <p className={`text-sm ${subText}`}>
                    No high-similarity matches found. Your text looks clean based on the AI-verified passages.
                  </p>
                )}
                {report.matches.map((m, idx) => (
                  <MatchRow key={idx} m={m} matchBg={matchBg} excerptBg={excerptBg} isDark={isDark} />
                ))}
              </CardContent>
            </Card>
          </div>
        )}

        <footer className={`mt-12 text-center text-xs ${footerText}`}>
          Uses Lovable AI + DeepSeek (OpenRouter) for ranking · Firecrawl / DuckDuckGo for search · Gemini embeddings for similarity.
          <br />
          Not a replacement for Turnitin — an assistive verification tool.
        </footer>
      </div>
    </div>
  );
}

function SettingsPopover({
  prefs,
  setPrefs,
}: {
  prefs: Prefs;
  setPrefs: (p: Partial<Prefs>) => void;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm">
          <Settings className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80" align="end">
        <div className="space-y-4">
          <div>
            <h3 className="text-sm font-semibold">Settings</h3>
            <p className="text-xs text-muted-foreground">
              Auto uses the preferred provider first and falls back automatically.
            </p>
          </div>

          <div className="flex items-center justify-between">
            <Label htmlFor="theme-switch" className="flex items-center gap-2 text-sm">
              {prefs.theme === "dark" ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
              {prefs.theme === "dark" ? "Dark mode" : "Light mode"}
            </Label>
            <Switch
              id="theme-switch"
              checked={prefs.theme === "dark"}
              onCheckedChange={(v) => setPrefs({ theme: v ? "dark" : "light" })}
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">LLM for passage ranking</Label>
            <Select
              value={prefs.llm}
              onValueChange={(v) => setPrefs({ llm: v as LlmPref })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Auto (DeepSeek → Gemini fallback)</SelectItem>
                <SelectItem value="deepseek">DeepSeek (OpenRouter, paid)</SelectItem>
                <SelectItem value="gemini">Gemini (Lovable AI)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Search engine</Label>
            <Select
              value={prefs.search}
              onValueChange={(v) => setPrefs({ search: v as SearchPref })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Auto (Firecrawl → DuckDuckGo fallback)</SelectItem>
                <SelectItem value="firecrawl">Firecrawl only</SelectItem>
                <SelectItem value="duckduckgo">DuckDuckGo only (free)</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function LogsSheet({ logs }: { logs: BuddyEntry[] }) {
  const recent = [...logs].reverse();
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button variant="outline" size="sm" className="relative">
          <Terminal className="h-4 w-4" />
          {logs.length > 0 && (
            <span className="ml-1 text-xs tabular-nums">{logs.length}</span>
          )}
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="w-full sm:max-w-lg">
        <SheetHeader>
          <SheetTitle className="flex items-center justify-between">
            <span>Activity Logs</span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => clearBuddyLogs()}
              className="h-7 px-2"
            >
              <Trash2 className="mr-1 h-3.5 w-3.5" /> Clear
            </Button>
          </SheetTitle>
        </SheetHeader>
        <ScrollArea className="mt-4 h-[calc(100vh-120px)] pr-3">
          {recent.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No activity yet. Run a plagiarism check to see which LLM and search backend gets used.
            </p>
          ) : (
            <div className="space-y-2">
              {recent.map((e, i) => (
                <LogEntry key={i} e={e} />
              ))}
            </div>
          )}
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}

function LogEntry({ e }: { e: BuddyEntry }) {
  const color: Record<BuddyEntry["kind"], string> = {
    rank: "bg-sky-500/10 text-sky-600 dark:text-sky-300 border-sky-500/30",
    search: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-300 border-emerald-500/30",
    similarity: "bg-violet-500/10 text-violet-600 dark:text-violet-300 border-violet-500/30",
    info: "bg-slate-500/10 text-slate-600 dark:text-slate-300 border-slate-500/30",
    error: "bg-red-500/10 text-red-600 dark:text-red-300 border-red-500/30",
  };
  return (
    <div className="rounded-md border p-3 text-xs">
      <div className="mb-1.5 flex items-center gap-2">
        <Badge variant="outline" className={color[e.kind]}>
          {e.kind}
        </Badge>
        <span className="text-muted-foreground tabular-nums">
          {e.ts.split("T")[1]?.replace("Z", "").slice(0, 8)}
        </span>
      </div>
      <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed">
        {JSON.stringify(e.detail, null, 2)}
      </pre>
    </div>
  );
}

function Stat({
  label,
  value,
  accent,
  bg,
  sub,
}: {
  label: string;
  value: string | number;
  accent?: boolean;
  bg: string;
  sub: string;
}) {
  return (
    <div
      className={`rounded-xl border p-4 ${
        accent ? "border-red-500/30 bg-red-500/10" : bg
      }`}
    >
      <div className={`text-xs uppercase tracking-wider ${sub}`}>{label}</div>
      <div className={`mt-1 text-2xl font-semibold ${accent ? "text-red-500 dark:text-red-300" : ""}`}>
        {value}
      </div>
    </div>
  );
}

function MatchRow({
  m,
  matchBg,
  excerptBg,
  isDark,
}: {
  m: Match;
  matchBg: string;
  excerptBg: string;
  isDark: boolean;
}) {
  const color =
    m.similarity >= 90
      ? "bg-red-500/20 text-red-700 dark:text-red-200 border-red-500/40"
      : m.similarity >= 70
        ? "bg-orange-500/20 text-orange-700 dark:text-orange-200 border-orange-500/40"
        : "bg-amber-500/15 text-amber-700 dark:text-amber-200 border-amber-500/40";
  return (
    <div className={`rounded-lg border p-4 ${matchBg}`}>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Badge variant="outline" className={color}>
          {m.similarity}% similar
        </Badge>
        <Badge variant="outline" className={isDark ? "border-white/10 text-slate-300" : ""}>
          {m.riskType}
        </Badge>
        <a
          href={m.source.url}
          target="_blank"
          rel="noreferrer"
          className="ml-auto flex items-center gap-1 text-xs text-sky-600 hover:underline dark:text-sky-300"
        >
          <LinkIcon className="h-3 w-3" /> {m.source.title || m.source.url}
        </a>
      </div>
      <p className="text-sm leading-relaxed">{m.text}</p>
      {m.matchedText && (
        <div className={`mt-3 rounded border p-3 text-xs leading-relaxed ${excerptBg}`}>
          <div className="mb-1 font-medium">Matched excerpt:</div>
          {m.matchedText}
        </div>
      )}
    </div>
  );
}
