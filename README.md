# Free Plagiarism Checker

AI-assisted web plagiarism verification with document upload, source checks,
similarity scoring, and PDF report export.

## What This App Uses
- React x Vite
- TanStack Start for routing, SSR, and server functions
- Tailwind CSS v4
- DeepSeek through OpenRouter (free credits + paid), with Gemini fallback for passage ranking
- Firecrawl (free credits + paid) is present, with DuckDuckGo fallback for web search

## Environment Variables
Create a local `.env` file when running manually
```bash
LOVABLE_API_KEY=your_lovable_key
OPENROUTER_API_KEY=your_openrouter_key
FIRECRAWL_API_KEY=your_firecrawl_key
```

`LOVABLE_API_KEY` is required for Gemini ranking fallback and Gemini embeddings.
`OPENROUTER_API_KEY` and `FIRECRAWL_API_KEY` are optional but improve results.

## Run Locally

Vite & React App with TanStack Routing.

```bash
bun install
bun run dev
```

Then open the local URL printed by Vite, usually `http://localhost:5173`.

To test a production build locally:

```bash
bun run build
bun run preview
```
