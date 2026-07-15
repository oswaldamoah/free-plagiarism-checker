import { jsPDF } from "jspdf";
import type { ScanReport } from "./types";

// Brand palette
const BRAND = {
  primary: [14, 165, 233] as [number, number, number], // sky-500
  primaryDark: [2, 132, 199] as [number, number, number], // sky-600
  ink: [15, 23, 42] as [number, number, number], // slate-900
  body: [51, 65, 85] as [number, number, number], // slate-700
  muted: [100, 116, 139] as [number, number, number], // slate-500
  line: [226, 232, 240] as [number, number, number], // slate-200
  soft: [248, 250, 252] as [number, number, number], // slate-50
  danger: [220, 38, 38] as [number, number, number], // red-600
  warn: [217, 119, 6] as [number, number, number], // amber-600
  ok: [22, 163, 74] as [number, number, number], // green-600
};

async function loadLogoDataUrl(): Promise<string | null> {
  try {
    const res = await fetch("/logo.png");
    if (!res.ok) return null;
    const blob = await res.blob();
    return await new Promise((resolve) => {
      const r = new FileReader();
      r.onloadend = () => resolve(typeof r.result === "string" ? r.result : null);
      r.onerror = () => resolve(null);
      r.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

function severityColor(sim: number): [number, number, number] {
  if (sim >= 70) return BRAND.danger;
  if (sim >= 40) return BRAND.warn;
  return BRAND.ok;
}

function severityLabel(sim: number) {
  if (sim >= 70) return "High";
  if (sim >= 40) return "Moderate";
  return "Low";
}

export async function downloadPdf(report: ScanReport) {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 48;
  const contentW = pageW - margin * 2;

  const logoData = await loadLogoDataUrl();

  let y = margin;

  const ensureSpace = (needed: number) => {
    if (y + needed > pageH - margin - 30) {
      addFooter();
      doc.addPage();
      y = margin;
      drawPageHeader(false);
    }
  };

  const setColor = (c: [number, number, number]) => doc.setTextColor(c[0], c[1], c[2]);
  const setFill = (c: [number, number, number]) => doc.setFillColor(c[0], c[1], c[2]);
  const setDraw = (c: [number, number, number]) => doc.setDrawColor(c[0], c[1], c[2]);

  const text = (
    str: string,
    x: number,
    yy: number,
    opts: { size?: number; bold?: boolean; color?: [number, number, number]; maxWidth?: number } = {},
  ) => {
    doc.setFont("helvetica", opts.bold ? "bold" : "normal");
    doc.setFontSize(opts.size ?? 10);
    setColor(opts.color ?? BRAND.body);
    const w = opts.maxWidth ?? contentW;
    const lines = doc.splitTextToSize(str, w) as string[];
    doc.text(lines, x, yy);
    return lines.length * (opts.size ?? 10) * 1.35;
  };

  // ---------- header ----------
  const drawPageHeader = (isFirst: boolean) => {
    // Top accent bar
    setFill(BRAND.primary);
    doc.rect(0, 0, pageW, 6, "F");

    if (isFirst && logoData) {
      try {
        doc.addImage(logoData, "PNG", margin, y, 36, 36);
      } catch {
        /* ignore */
      }
    }

    if (isFirst) {
      const tx = logoData ? margin + 48 : margin;
      setColor(BRAND.ink);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(18);
      doc.text("Plagiarism Analysis Report", tx, y + 16);
      setColor(BRAND.muted);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(9);
      doc.text(
        `Generated ${new Date(report.createdAt).toLocaleString()}`,
        tx,
        y + 32,
      );
      y += 56;
    } else {
      setColor(BRAND.muted);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8);
      doc.text("Plagiarism Analysis Report", margin, 20);
      doc.text(report.filename, pageW - margin, 20, { align: "right" });
      y = margin;
    }
  };

  const addFooter = () => {
    const pageNum = doc.getNumberOfPages();
    setColor(BRAND.muted);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.text(
      "Free Plagiarism Checker — AI-assisted verification",
      margin,
      pageH - 20,
    );
    doc.text(`Page ${pageNum}`, pageW - margin, pageH - 20, { align: "right" });
  };

  drawPageHeader(true);

  // ---------- document card ----------
  const docCardH = 44;
  setFill(BRAND.soft);
  setDraw(BRAND.line);
  doc.roundedRect(margin, y, contentW, docCardH, 6, 6, "FD");
  setColor(BRAND.muted);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.text("DOCUMENT", margin + 14, y + 16);
  setColor(BRAND.ink);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(12);
  doc.text(
    doc.splitTextToSize(report.filename, contentW - 28) as string[],
    margin + 14,
    y + 32,
  );
  y += docCardH + 18;

  // ---------- overall score hero ----------
  const heroH = 88;
  const overall = report.summary.overallSimilarity;
  const heroColor = severityColor(overall);
  setFill(heroColor);
  doc.roundedRect(margin, y, contentW, heroH, 8, 8, "F");

  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.setTextColor(255, 255, 255);
  doc.text("OVERALL PLAGIARISM SCORE", margin + 20, y + 22);

  doc.setFontSize(40);
  doc.text(`${overall}%`, margin + 20, y + 62);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(11);
  doc.text(severityLabel(overall) + " risk", margin + 20, y + 78);

  // stats on the right
  const rightX = margin + contentW - 180;
  doc.setFontSize(9);
  const stats = [
    ["Total words", report.summary.totalWords.toLocaleString()],
    ["Passages checked", String(report.summary.paragraphsChecked)],
    ["Suspicious passages", String(report.summary.suspiciousPassages)],
    ["Matches found", String(report.matches.length)],
  ];
  stats.forEach((row, i) => {
    doc.setFont("helvetica", "normal");
    doc.text(row[0], rightX, y + 22 + i * 15);
    doc.setFont("helvetica", "bold");
    doc.text(row[1], margin + contentW - 20, y + 22 + i * 15, { align: "right" });
  });

  y += heroH + 24;

  // ---------- section: matches ----------
  ensureSpace(40);
  setColor(BRAND.ink);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(14);
  doc.text("Detected Matches", margin, y);
  setColor(BRAND.muted);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.text(`${report.matches.length} result${report.matches.length === 1 ? "" : "s"}`, pageW - margin, y, {
    align: "right",
  });
  y += 8;
  setDraw(BRAND.line);
  doc.setLineWidth(0.5);
  doc.line(margin, y, pageW - margin, y);
  y += 18;

  if (!report.matches.length) {
    setFill(BRAND.soft);
    setDraw(BRAND.line);
    doc.roundedRect(margin, y, contentW, 60, 6, 6, "FD");
    setColor(BRAND.ok);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(12);
    doc.text("No high-similarity matches found", margin + 16, y + 26);
    setColor(BRAND.muted);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.text(
      "Your text appears clean based on AI-verified passages.",
      margin + 16,
      y + 44,
    );
    y += 76;
  }

  report.matches.forEach((m, i) => {
    // measure card height dynamically
    doc.setFontSize(10);
    const passageLines = doc.splitTextToSize(m.text, contentW - 32) as string[];
    const excerptLines = doc.splitTextToSize(
      m.matchedText || "(snippet unavailable)",
      contentW - 32,
    ) as string[];
    const sourceLines = doc.splitTextToSize(m.source.title, contentW - 120) as string[];

    const cardH =
      52 + // header block
      18 + passageLines.length * 12 +
      18 + excerptLines.length * 12 +
      18 + sourceLines.length * 12 +
      18;

    ensureSpace(cardH + 12);

    const cardY = y;
    const sev = severityColor(m.similarity);

    // Card
    setFill(255, 255, 255);
    doc.setFillColor(255, 255, 255);
    setDraw(BRAND.line);
    doc.setLineWidth(0.6);
    doc.roundedRect(margin, cardY, contentW, cardH, 8, 8, "FD");

    // Left severity stripe
    setFill(sev);
    doc.rect(margin, cardY, 4, cardH, "F");

    // Header row
    setColor(BRAND.ink);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.text(`Match ${i + 1}`, margin + 16, cardY + 22);

    // Similarity pill
    const pillW = 90;
    const pillX = margin + contentW - pillW - 16;
    setFill(sev);
    doc.roundedRect(pillX, cardY + 10, pillW, 20, 10, 10, "F");
    doc.setTextColor(255, 255, 255);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.text(`${m.similarity}% · ${severityLabel(m.similarity)}`, pillX + pillW / 2, cardY + 23, {
      align: "center",
    });

    // Risk type
    setColor(BRAND.muted);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.text(m.riskType.toUpperCase(), margin + 16, cardY + 38);

    // Divider
    setDraw(BRAND.line);
    doc.setLineWidth(0.4);
    doc.line(margin + 12, cardY + 46, margin + contentW - 12, cardY + 46);

    let cy = cardY + 60;

    // Original passage
    setColor(BRAND.muted);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8);
    doc.text("ORIGINAL PASSAGE", margin + 16, cy);
    cy += 12;
    setColor(BRAND.body);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.text(passageLines, margin + 16, cy);
    cy += passageLines.length * 12 + 12;

    // Matched excerpt
    setColor(BRAND.muted);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8);
    doc.text("MATCHED EXCERPT", margin + 16, cy);
    cy += 12;
    setColor(BRAND.body);
    doc.setFont("helvetica", "italic");
    doc.setFontSize(10);
    doc.text(excerptLines, margin + 16, cy);
    cy += excerptLines.length * 12 + 12;

    // Source
    setColor(BRAND.muted);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8);
    doc.text("SOURCE", margin + 16, cy);
    cy += 12;
    setColor(BRAND.primaryDark);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    doc.text(sourceLines, margin + 16, cy);
    cy += sourceLines.length * 12;
    setColor(BRAND.muted);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    const urlLines = doc.splitTextToSize(m.source.url, contentW - 32) as string[];
    doc.text(urlLines, margin + 16, cy + 2);
    // clickable link overlay
    doc.link(margin + 16, cy - 8, contentW - 32, 16, { url: m.source.url });

    y = cardY + cardH + 12;
  });

  addFooter();

  doc.save(`${report.filename.replace(/\.[^.]+$/, "")}-plagiarism-report.pdf`);
}
