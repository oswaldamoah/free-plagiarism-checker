export interface Match {
  passageId: string;
  text: string;
  similarity: number;
  riskType: string;
  matchedText: string;
  source: { title: string; url: string };
}

export interface ScanReport {
  filename: string;
  summary: {
    totalWords: number;
    paragraphsChecked: number;
    suspiciousPassages: number;
    overallSimilarity: number;
  };
  matches: Match[];
  createdAt: string;
}
