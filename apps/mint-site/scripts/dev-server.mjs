// A static server for web/ with the same headers Vercel sends (the CSP comes from the config being served), so what
// works here works there. When web/site.config.local.json exists (a copy pointed at a local chain: the mint package's
// site-config can write it), it is served as /site.config.json.
//
//   node scripts/dev-server.mjs [--port 5180]
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { vercelConfig } from "./vercel.mjs";

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "web");
const at = process.argv.indexOf("--port");
const PORT = at > 0 ? Number(process.argv[at + 1]) : 5180;
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".jpg": "image/jpeg", ".ico": "image/x-icon",
};
const configFile = () => (fs.existsSync(path.join(WEB, "site.config.local.json")) ? "site.config.local.json" : "site.config.json");

http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  let rel = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
  if (rel === "site.config.json") rel = configFile();
  const file = path.resolve(WEB, rel);
  if (!file.startsWith(WEB + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
    res.end(fs.readFileSync(path.join(WEB, "404.html")));
    return;
  }
  const site = JSON.parse(fs.readFileSync(path.join(WEB, configFile()), "utf8"));
  const headers = Object.fromEntries(vercelConfig(site).headers[0].headers.map((h) => [h.key, h.value]));
  res.writeHead(200, { ...headers, "content-type": TYPES[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => console.log(`mint site on http://localhost:${PORT}  (config: web/${configFile()})`));
