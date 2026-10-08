/**
 * www.clockoff.online → clockoff.online (Railway service "www", railway/www.json). Railway's Hobby plan allows two
 * custom domains per service, so the web service carries the apex and app hosts and this dependency-free server
 * answers www with the same permanent redirect the web app's host routing gives aliases (308, same path and
 * query). GET /healthz answers 200 for Railway's health check.
 */
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

/** Returns the request handler, or throws when `target` is not a bare https origin. */
export function createRedirectHandler(target) {
  const origin = new URL(target);
  if (origin.protocol !== "https:" || origin.origin !== target.replace(/\/$/, "")) {
    throw new Error("REDIRECT_TO must be a bare https origin, e.g. https://clockoff.online");
  }
  return (req, res) => {
    const url = req.url && req.url.startsWith("/") ? req.url : "/";
    if (url === "/healthz") {
      res.writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end("ok");
      return;
    }
    // Path + query only: the Host header and absolute-form request targets never choose the destination.
    res.writeHead(308, {
      location: `${origin.origin}${url}`,
      "cache-control": "public, max-age=3600",
      "strict-transport-security": "max-age=63072000; includeSubDomains",
    });
    res.end();
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const server = createServer(
    createRedirectHandler(process.env.REDIRECT_TO ?? "https://clockoff.online"),
  );
  server.listen(Number(process.env.PORT ?? 8080), "0.0.0.0");
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
