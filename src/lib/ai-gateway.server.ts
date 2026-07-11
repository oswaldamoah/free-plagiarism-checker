// src/lib/ai-gateway.server.ts
import { createGoogleGenerativeAI } from "@ai-sdk/google";

export function createGeminiAiGatewayProvider(_apiKey?: string) {
  const provider = createGoogleGenerativeAI({
    apiKey: process.env.GEMINI_API_KEY!,
  });
  // keep the same call signature the rest of the app uses:
  //   gateway("google/gemini-3-flash-preview")
  //   gateway.textEmbeddingModel("google/gemini-embedding-001")
  const wrap: any = (id: string) => provider(id.replace(/^google\//, ""));
  wrap.textEmbeddingModel = (id: string) =>
    provider.textEmbeddingModel(id.replace(/^google\//, ""));
  return wrap;
}
