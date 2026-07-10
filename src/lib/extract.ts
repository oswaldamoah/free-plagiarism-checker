// Client-side document text extraction. Files stay in memory only.
import mammoth from "mammoth";

export async function extractText(file: File): Promise<string> {
  const name = file.name.toLowerCase();
  if (name.endsWith(".txt")) return await file.text();
  if (name.endsWith(".docx")) {
    const buf = await file.arrayBuffer();
    const { value } = await mammoth.extractRawText({ arrayBuffer: buf });
    return value;
  }
  if (name.endsWith(".pdf")) {
    // pdfjs-dist v6 legacy build works in modern browsers without a worker file
    const pdfjs = await import("pdfjs-dist");
    // Disable worker so we don't need to ship the worker asset
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (pdfjs as any).GlobalWorkerOptions.workerSrc = "";
    const buf = await file.arrayBuffer();
    const doc = await pdfjs.getDocument({
      data: buf,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      disableWorker: true,
      isEvalSupported: false,
      useSystemFonts: true,
    } as unknown as Parameters<typeof pdfjs.getDocument>[0]).promise;
    let out = "";
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      out +=
        content.items
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .map((it: any) => it.str ?? "")
          .join(" ") + "\n\n";
    }
    return out;
  }
  throw new Error(`Unsupported file type: ${file.name}`);
}

export interface Chunk {
  id: string;
  text: string;
  wordCount: number;
}

const HEADING_RE = /^(chapter|section|references|bibliography|table of contents|contents|abstract)\b/i;

export function segmentText(raw: string): Chunk[] {
  const paras = raw
    .replace(/\r\n/g, "\n")
    .split(/\n\s*\n+/)
    .map((p) => p.trim())
    .filter(Boolean);

  const chunks: Chunk[] = [];
  let buffer: string[] = [];
  let bufWords = 0;

  const flush = () => {
    if (!bufWords) return;
    const text = buffer.join(" ").trim();
    if (bufWords >= 50) {
      chunks.push({ id: `p${chunks.length + 1}`, text, wordCount: bufWords });
    }
    buffer = [];
    bufWords = 0;
  };

  for (const p of paras) {
    if (HEADING_RE.test(p) || p.length < 30) continue;
    const words = p.split(/\s+/);
    if (words.length > 250) {
      // hard-split long paragraphs into ~200-word chunks
      for (let i = 0; i < words.length; i += 200) {
        const slice = words.slice(i, i + 200);
        if (slice.length >= 50) {
          chunks.push({
            id: `p${chunks.length + 1}`,
            text: slice.join(" "),
            wordCount: slice.length,
          });
        }
      }
      continue;
    }
    buffer.push(p);
    bufWords += words.length;
    if (bufWords >= 100) flush();
  }
  flush();
  return chunks;
}

export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}
