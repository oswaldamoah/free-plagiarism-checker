// Node server wrapper for TanStack Start fetch handler.
// Keeps the app working in production-like environments where you need a real Node HTTP server.

import http from "http";
import { URL } from "url";
import serverEntry from "./.output/server/index.mjs";




const PORT: number = Number(process.env.PORT ?? 3000);
const HOST: string = process.env.HOST ?? "0.0.0.0";

async function readBody(req: any): Promise<Uint8Array | undefined> {
  if (!req.method || ["GET", "HEAD"].includes(req.method)) return undefined;
  const chunks: any[] = [];
  for await (const c of req) chunks.push(c);
  const buf = (Buffer as any).concat(chunks);
  return buf.length ? new Uint8Array(buf) : undefined;

}

function writeResponse(res: any, response: Response) {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === "transfer-encoding") return;
    res.setHeader(key, value);
  });

  if (!response.body) {
    res.end();
    return;
  }

  const reader = response.body.getReader();
  (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) res.write(Buffer.from(value));
    }
    res.end();
  })().catch((e) => {
    console.error("Failed to write response body", e);
    res.end();
  });
}

http
  .createServer(async (req: any, res: any) => {
    try {
      const host = req.headers?.host ?? `${HOST}:${PORT}`;
      const proto = req.headers?.["x-forwarded-proto"] ?? "http";

      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers ?? {})) {
        if (typeof v === "string") headers[k] = v;
        else if (Array.isArray(v)) headers[k] = v.join(",");
        else if (v == null) headers[k] = "";
        else headers[k] = String(v);
      }
      headers.host = host;

      const bodyBytes = await readBody(req);

      const fullUrl = new URL(req.url ?? "/", `${proto}://${host}`);

      const request = new Request(fullUrl.toString(), {
        method: req.method,
        headers,
        // fetch BodyInit accepts ArrayBuffer/Uint8Array
        body: bodyBytes as any,
      });

      const env = process.env;
      const handlerFetch = (serverEntry as any)?.default?.fetch ?? (serverEntry as any)?.fetch;
      const response: Response = await handlerFetch(request, env, undefined);

      writeResponse(res, response);
    } catch (e) {
      console.error(e);
      res.statusCode = 500;
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end(e instanceof Error ? e.message : "Internal Server Error");
    }
  })
  .listen(PORT, HOST, () => {
    console.log(`TanStack node server listening on http://${HOST}:${PORT}`);
  });


