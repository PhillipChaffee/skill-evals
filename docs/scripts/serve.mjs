/* global URL, console, process */

// Serves the built site the way GitHub Pages does: under the base path of
// SITE_URL, with every other address answering 404. Open the printed address
// to see the landing page and the docs together.
//
// Usage: node scripts/serve.mjs [port]
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { SITE_URL } from "../site-url.mjs";

const root = path.resolve(import.meta.dirname, "../dist");
const base = new URL(SITE_URL).pathname;
const port = Number(process.argv[2] ?? 4321);
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
};

http
  .createServer((request, response) => {
    const { pathname } = new URL(request.url ?? "/", "http://localhost");
    const relative = decodeURIComponent(pathname.slice(base.length));
    const file = path.join(
      root,
      relative.endsWith("/") || relative === ""
        ? `${relative}index.html`
        : relative,
    );
    const inside = pathname.startsWith(base) && file.startsWith(root);
    if (!inside || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      response
        .writeHead(404, { "content-type": "text/plain" })
        .end("Not found\n");
      return;
    }
    response.writeHead(200, {
      "content-type": TYPES[path.extname(file)] ?? "application/octet-stream",
    });
    fs.createReadStream(file).pipe(response);
  })
  .listen(port, () => {
    console.log(`http://localhost:${port}${base}`);
  });
