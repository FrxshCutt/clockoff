/**
 * Mock Planday over HTTP (plan §12.1), for local development and Playwright: web and the worker are separate
 * processes and must see one portal, so both send their Planday traffic here. Their transport rewrites
 * `https://openapi.planday.com/…` to `${PLANDAY_MOCK_URL}/openapi/…` and `https://id.planday.com/…` to
 * `${PLANDAY_MOCK_URL}/id/…` (plan §4.1); this server maps them back onto the same handler as the in-process
 * mock. `POST /__control` runs the plan §12.4 controls (`{ action, ...arguments }`, see `runControlAction`;
 * also `requestLog`, `unexpectedRequests` and `clearLogs`), `GET /__health` answers readiness probes.
 *
 * Binds to 127.0.0.1 by default and refuses to start in production (`guard.ts`).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { runControlAction } from "./controls";
import { assertMockPlandayAllowed } from "./guard";
import {
  createMockPlanday,
  PLANDAY_API_ORIGIN,
  PLANDAY_IDENTITY_ORIGIN,
  type CreateMockPlandayOptions,
  type MockPlanday,
} from "./server";
import { MockControlError } from "./state";

/** Default port (`PLANDAY_MOCK_PORT`), matching `PLANDAY_MOCK_URL`'s default `http://127.0.0.1:4010`. */
export const MOCK_PLANDAY_DEFAULT_PORT = 4010;

export interface StartMockPlandayHttpServerOptions extends CreateMockPlandayOptions {
  /** Default 4010; 0 picks a free port. */
  port?: number;
  /** Default 127.0.0.1 (never exposed beyond the machine). */
  host?: string;
  /** Serve an existing mock instead of creating one from the other options. */
  mock?: MockPlanday;
}

export interface MockPlandayHttpServer {
  /** `http://<host>:<port>`, the value for `PLANDAY_MOCK_URL`. */
  readonly url: string;
  readonly port: number;
  readonly mock: MockPlanday;
  readonly server: Server;
  close(): Promise<void>;
}

const HOP_BY_HOP = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "keep-alive",
  "upgrade",
  "expect",
]);

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req)
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

async function forward(
  mock: MockPlanday,
  origin: string,
  rest: string,
  req: IncomingMessage,
  res: ServerResponse,
) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined || HOP_BY_HOP.has(key)) continue;
    for (const item of Array.isArray(value) ? value : [value]) headers.append(key, item);
  }
  const method = (req.method ?? "GET").toUpperCase();
  // Read for every method: the in-process mock records a body on a GET as an unexpected request.
  const body = await readBody(req);
  const response = await mock.fetch(`${origin}${rest}`, {
    method,
    headers,
    ...(body !== "" ? { body } : {}),
  });
  const text = await response.text();
  const outgoing: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key)) outgoing[key] = value;
  });
  res.writeHead(response.status, { ...outgoing, "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function handler(mock: MockPlanday) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? "/", "http://mock-planday.invalid");
      const pathWithQuery = `${url.pathname}${url.search}`;
      if (url.pathname === "/__health" && req.method === "GET") {
        sendJson(res, 200, {
          status: "ok",
          mock: "planday",
          now: new Date(mock.state.now()).toISOString(),
          portals: [...mock.state.portals.keys()],
        });
        return;
      }
      if (url.pathname === "/__control") {
        if (req.method !== "POST") {
          sendJson(res, 405, { ok: false, error: "POST { action, ...arguments }" });
          return;
        }
        let payload: unknown;
        try {
          payload = JSON.parse((await readBody(req)) || "{}");
        } catch {
          sendJson(res, 400, { ok: false, error: "body must be JSON" });
          return;
        }
        const action = (payload as { action?: unknown } | null)?.action;
        if (action === "requestLog") {
          sendJson(res, 200, { ok: true, result: mock.requestLog });
          return;
        }
        if (action === "unexpectedRequests") {
          sendJson(res, 200, { ok: true, result: mock.unexpectedRequests });
          return;
        }
        if (action === "clearLogs") {
          mock.requestLog.length = 0;
          mock.unexpectedRequests.length = 0;
          sendJson(res, 200, { ok: true, result: null });
          return;
        }
        try {
          const result = runControlAction(mock.controls, payload);
          sendJson(res, 200, { ok: true, result: result ?? null });
        } catch (error) {
          if (error instanceof MockControlError) {
            sendJson(res, 400, { ok: false, error: error.message });
            return;
          }
          throw error;
        }
        return;
      }
      if (url.pathname.startsWith("/openapi/")) {
        await forward(mock, PLANDAY_API_ORIGIN, pathWithQuery.slice("/openapi".length), req, res);
        return;
      }
      if (url.pathname.startsWith("/id/")) {
        await forward(mock, PLANDAY_IDENTITY_ORIGIN, pathWithQuery.slice("/id".length), req, res);
        return;
      }
      mock.unexpectedRequests.push({
        at: new Date(mock.state.now()).toISOString(),
        method: req.method ?? "GET",
        url: pathWithQuery,
        path: url.pathname,
        reason: "not under /openapi/ or /id/ on the Mock Planday server",
      });
      sendJson(res, 404, {
        error: "Mock Planday serves /openapi/*, /id/*, /__control and /__health",
      });
    } catch (error) {
      if (!res.headersSent) {
        sendJson(res, 500, {
          error: error instanceof Error ? error.message : "Mock Planday failed",
        });
      } else {
        res.destroy();
      }
    }
  };
}

/**
 * Starts the shared Mock Planday server (`apps/web/scripts/mock-planday.mts`, Playwright, the dev routes'
 * target). Throws in production.
 */
export async function startMockPlandayHttpServer(
  options: StartMockPlandayHttpServerOptions = {},
): Promise<MockPlandayHttpServer> {
  assertMockPlandayAllowed("startMockPlandayHttpServer", options.env);
  const {
    port = MOCK_PLANDAY_DEFAULT_PORT,
    host = "127.0.0.1",
    mock: given,
    ...mockOptions
  } = options;
  const mock = given ?? createMockPlanday(mockOptions);
  const handle = handler(mock);
  const server = createServer((req, res) => {
    void handle(req, res);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  const urlHost = address.family === "IPv6" ? `[${address.address}]` : address.address;
  return {
    url: `http://${urlHost}:${address.port}`,
    port: address.port,
    mock,
    server,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
