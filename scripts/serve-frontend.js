/**
 * AVIGHNAA — development static server for the control-room dashboard.
 *
 * Serves the `frontend/` folder on http://localhost:8080 with the same
 * routes and MIME types as a plain static file server, and — crucially for
 * development — WITHOUT any caching, so an edited .js/.css file is picked
 * up on the next reload instead of being served from the browser cache.
 *
 * This is a DEVELOPMENT helper only. It is not used in production: the
 * backend (server.js) exposes the API, and the dashboard is served as
 * static files by whatever hosts the deployment.
 *
 * Usage:
 *   node scripts/serve-frontend.js            # http://localhost:8080
 *   PORT=9000 node scripts/serve-frontend.js  # custom port
 *   HOST=0.0.0.0 node scripts/serve-frontend.js
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "frontend");
const PORT = Number.parseInt(process.env.PORT || "8080", 10);
const HOST = process.env.HOST || "127.0.0.1";

// Same mapping the previous `python -m http.server` produced.
const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/vnd.microsoft.icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".eot": "application/vnd.ms-fontobject",
  ".wasm": "application/wasm",
  ".pdf": "application/pdf",
};

function contentType(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

/**
 * Resolve a request path to a file inside ROOT.
 * Returns null when the path escapes the root or does not exist.
 */
function resolveTarget(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath.split("?")[0]);
  } catch {
    return null;
  }

  if (decoded.includes("\0")) return null;

  // Treat the request as relative to the root, then verify it stays inside.
  const relative = decoded.replace(/^\/+/, "");
  const target = path.resolve(ROOT, relative);

  if (target !== ROOT && !target.startsWith(ROOT + path.sep)) {
    return null; // path traversal attempt
  }

  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    return null;
  }

  if (stat.isDirectory()) {
    const index = path.join(target, "index.html");
    if (fs.existsSync(index) && fs.statSync(index).isFile()) {
      return index;
    }
    return null;
  }

  return target;
}

const server = http.createServer((req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8", Allow: "GET, HEAD" });
    res.end("Method Not Allowed");
    return;
  }

  const file = resolveTarget(req.url || "/");

  if (!file) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not Found");
    return;
  }

  let body;
  try {
    body = fs.readFileSync(file);
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Internal Server Error: " + err.message);
    return;
  }

  res.writeHead(200, {
    "Content-Type": contentType(file),
    "Content-Length": body.length,
    // Development only: never let the browser cache a dashboard asset.
    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
    Pragma: "no-cache",
    Expires: "0",
  });

  if (req.method === "HEAD") {
    res.end();
  } else {
    res.end(body);
  }
});

if (!Number.isInteger(PORT) || PORT <= 0 || PORT > 65535) {
  console.error(`Invalid PORT "${process.env.PORT}" — using 8080`);
}

server.listen(Number.isInteger(PORT) ? PORT : 8080, HOST, () => {
  console.log(`AVIGHNAA frontend (dev) on http://${HOST}:${PORT}`);
  console.log(`  serving   : ${ROOT}`);
  console.log(`  caching   : disabled (Cache-Control: no-store)`);
});

server.on("error", (err) => {
  console.error(`Frontend dev server failed: ${err.message}`);
  process.exit(1);
});
