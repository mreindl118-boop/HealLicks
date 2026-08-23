/**
 * Minimal static file server for the built PWA (no framework — the bridge
 * should stay a small dependency-light daemon). SPA fallback to index.html;
 * /healthz returns bridge + link status as JSON.
 */

import { createReadStream, existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

export interface StaticServerOptions {
  rootDir: string;
  healthz: () => unknown;
}

export function createStaticHandler(options: StaticServerOptions) {
  return (request: IncomingMessage, response: ServerResponse): void => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === "/healthz") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(options.healthz(), null, 2));
      return;
    }

    // Resolve inside rootDir only (normalize strips ../ traversal).
    const safePath = normalize(url.pathname).replace(/^(\.\.[/\\])+/, "");
    let filePath = join(options.rootDir, safePath);
    if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
      filePath = join(options.rootDir, "index.html");
    }
    if (!existsSync(filePath)) {
      response.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
      response.end(
        "Stadium Deck bridge is running, but the app is not built yet.\nRun: npm run build\n",
      );
      return;
    }
    response.writeHead(200, {
      "content-type": CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream",
      "cache-control": "no-cache",
    });
    createReadStream(filePath).pipe(response);
  };
}
