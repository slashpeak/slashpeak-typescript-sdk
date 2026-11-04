import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Router, type Decision } from "../src/core/router.js";
import { makeSettings, type SettingsInput } from "../src/core/settings.js";
import type { Reply, RequestOptions, Transport } from "../src/core/transport.js";

// Tests run from .test-build/test/: the spec is two levels up.
export function loadSpec(name: string): any {
  return JSON.parse(readFileSync(new URL(`../../spec/${name}`, import.meta.url), "utf8"));
}

export interface Call {
  method: string;
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
}

/** Records calls; answers decide from a queue. */
export class FakeTransport {
  calls: Call[] = [];
  decideReplies: Array<Reply | null> = [];
  defaultDecide: Reply | null = null;
  configReply: Reply = { status: 200, body: { accepted: 0 }, etag: null };
  closed = false;

  async requestWithDeadline(method: string, path: string, body: unknown): Promise<Reply | null> {
    this.calls.push({ method, path, body });
    return this.decideReplies.length > 0 ? this.decideReplies.shift()! : this.defaultDecide;
  }

  async request(method: string, path: string, options: RequestOptions = {}): Promise<Reply> {
    this.calls.push({ method, path, body: options.body, headers: options.headers });
    if (path === "/v1/config") return this.configReply;
    return { status: 200, body: { accepted: 0 }, etag: null };
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  decides(): Call[] {
    return this.calls.filter((c) => c.path === "/v1/decide");
  }

  events(): any[] {
    return this.calls.filter((c) => c.path === "/v1/events").flatMap((c) => (c.body as { events: any[] }).events);
  }
}

export function decision(options: Partial<{ action: string; reservation: string; mode: string; label: string; decisionId: string | null; ttl: number; scope: string }> = {}): Decision {
  const body: Decision = {
    decisionId: options.decisionId === undefined ? "d1-k1-abc-0011223344-ffeeddccbbaa" : options.decisionId,
    action: options.action ?? "keep",
    reservation: options.reservation ?? "none",
    ttlSeconds: options.ttl ?? 60,
    cacheScope: options.scope ?? "sql",
    mode: options.mode ?? "active",
    explanation: {},
  };
  if (options.label) body.labels = { slashpeak_route: options.label };
  return body;
}

export const RES = "projects/admin/locations/US/reservations/etl";
export const MOVE = decision({ action: "set_reservation", reservation: RES, label: "m_d1-k1-abc-0011223344-ffeeddccbbaa" });
export const ok = (body: Decision): Reply => ({ status: 200, body, etag: null });

export function makeRouter(settings: SettingsInput = {}, transport: FakeTransport = new FakeTransport(), clock?: () => number): { router: Router; transport: FakeTransport } {
  const router = new Router(makeSettings({ apiKey: "k", endpoint: "https://router.example", ...settings }), {
    transport: transport as unknown as Transport,
    clock,
    timers: false,
  });
  return { router, transport };
}

export function insertBody(sql = "SELECT 1", extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    jobReference: { projectId: "p", jobId: "job_1", location: "US" },
    configuration: { query: { query: sql, useLegacySql: false, ...extra } },
  };
}

export type Handler = (method: string, path: string, body: any, req: IncomingMessage) => [number, unknown] | Promise<[number, unknown]>;

export interface TestServer {
  url: string;
  hits: Array<{ method: string; path: string; body: any; headers: IncomingMessage["headers"] }>;
  connections: number;
  close(): Promise<void>;
}

/** A local HTTP/1.1 server (keep-alive) that answers JSON. */
export async function serve(handler: Handler, raw?: (req: IncomingMessage, res: ServerResponse) => boolean): Promise<TestServer> {
  const hits: TestServer["hits"] = [];
  const state = { connections: 0 };
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    const body = text ? JSON.parse(text) : null;
    const path = (req.url ?? "").split("?")[0]!;
    hits.push({ method: req.method ?? "GET", path, body, headers: req.headers });
    if (raw && raw(req, res)) return;
    const [status, reply] = await handler(req.method ?? "GET", path, body, req);
    const data = Buffer.from(JSON.stringify(reply));
    res.writeHead(status, { "content-type": "application/json", "content-length": data.length, "set-cookie": "track=1" });
    res.end(data);
  });
  server.on("connection", () => {
    state.connections += 1;
  });
  server.keepAliveTimeout = 30_000;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    hits,
    get connections() {
      return state.connections;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
