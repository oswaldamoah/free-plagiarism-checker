import { jsPDF } from "jspdf";
import type { ScanReport } from "./types";

export function downloadPdf(report: ScanReport) {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const margin = 48;
  let y = margin;

  const line = (text: string, size = 11, bold = false) => {
    doc.setFontSize(size);
    doc.setFont("helvetica", bold ? "bold" : "normal");
    const wrapped = doc.splitTextToSize(text, pageW - margin * 2);
    for (const l of wrapped) {
      if (y > 780) {
        doc.addPage();
        y = margin;
      }
      doc.text(l, margin, y);
      y += size * 1.35;
    }
  };
  const gap = (v = 8) => (y += v);

  line("Plagiarism Analysis Report", 20, true);
  line(new Date().toLocaleString(), 10);
  gap(12);

  line(`Document: ${report.filename}`, 12, true);
  gap();
  line(`Total Words: ${report.summary.totalWords}`);
  line(`Paragraphs Checked: ${report.summary.paragraphsChecked}`);
  line(`Suspicious Passages: ${report.summary.suspiciousPassages}`);
  line(`Overall Similarity: ${report.summary.overallSimilarity}%`);
  gap(16);

  line("Detected Matches", 14, true);
  gap();
  if (!report.matches.length) {
    line("No high-similarity matches found.");
  }
  report.matches.forEach((m, i) => {
    gap(6);
    line(`${i + 1}. Similarity: ${m.similarity}%  ·  ${m.riskType}`, 11, true);
    line(`Source: ${m.source.title}`);
    line(m.source.url, 9);
    gap(4);
    line(`Original passage:`, 10, true);
    line(m.text);
    gap(4);
    line(`Matched excerpt:`, 10, true);
    line(m.matchedText || "(snippet unavailable)");
    gap(6);
  });

  doc.save(`${report.filename.replace(/\.[^.]+$/, "")}-plagiarism-report.pdf`);
}
