/**
 * HTTPS to the router: one pooled keep-alive agent per process.
 *
 * Connection rules:
 *
 * - **One agent, one pool.** An undici agent keeps TLS connections open between
 *   calls (HTTP/1.1 keep-alive), so a warm decide pays no TCP or TLS handshake.
 *   At most `MAX_CONNECTIONS` sockets: a burst of calls waits in the agent's
 *   queue, and the deadline below still bounds the wait.
 * - **No hidden retries, no redirects, no cookies.** undici's `request` does
 *   none of these. A failed call is a failed call; the job runs unchanged.
 * - **One hard deadline for a decide.** `AbortSignal.timeout` covers the queue,
 *   DNS, connect, TLS and the answer (500 ms end to end). A late answer is dropped.
 * - **Background calls** (events, config) use longer timeouts on the same pool;
 *   they never hold up a job.
 * - **TLS verified, proxies from the environment** (`HTTPS_PROXY`, `NO_PROXY`),
 *   bounded response size, the key only in the `Authorization` header, never in
 *   a URL or a log.
 * - Node does not fork a running process (cluster and child processes start
 *   fresh), so no socket is ever shared between processes.
 */

import { EnvHttpProxyAgent, type Dispatcher } from "undici";
import { VERSION } from "../version.js";

/** Plan: 500 ms end to end, DNS included. */
export const DECIDE_DEADLINE_MS = 500;
/** Events and config run off the job's path. */
export const BACKGROUND_TIMEOUT_MS = 5000;
export const CONNECT_TIMEOUT_MS = 2000;
export const MAX_CONNECTIONS = 8;
/** Router answers are small; a bigger body is not ours. */
export const MAX_RESPONSE_BYTES = 1024 * 1024;

export interface Reply {
  status: number;
  body: Record<string, unknown> | null;
  etag: string | null;
}

export interface RequestOptions {
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export type DispatcherFactory = () => Dispatcher;

export function buildDispatcher(): Dispatcher {
  return new EnvHttpProxyAgent({
    connections: MAX_CONNECTIONS,
    connect: { timeout: CONNECT_TIMEOUT_MS },
    keepAliveTimeout: 30_000,
    keepAliveMaxTimeout: 600_000,
  });
}

let libraryAgent = "";

/** Adds the warehouse library to the User-Agent (set by the hook that knows it). */
export function setLibraryAgent(value: string): void {
  libraryAgent = value.slice(0, 128);
}

function userAgent(): string {
  return libraryAgent ? `slashpeak-typescript/${VERSION} ${libraryAgent}` : `slashpeak-typescript/${VERSION}`;
}

async function readReply(response: Dispatcher.ResponseData): Promise<Reply> {
  let body: Record<string, unknown> | null = null;
  const chunks: Buffer[] = [];
  let size = 0;
  let tooBig = false;
  try {
    for await (const chunk of response.body) {
      const buffer = chunk as Buffer;
      size += buffer.length;
      if (size > MAX_RESPONSE_BYTES) {
        tooBig = true;
        break;
      }
      chunks.push(buffer);
    }
    if (!tooBig && size > 0) {
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      body = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    }
  } catch {
    body = null;
  } finally {
    if (tooBig) response.body.destroy();
  }
  const etag = response.headers["etag"];
  return { status: response.statusCode, body, etag: typeof etag === "string" ? etag : null };
}

export class Transport {
  private readonly endpoint: string;
  private dispatcher: Dispatcher | null = null;
  private closed = false;

  constructor(
    endpoint: string,
    private readonly apiKey: string,
    private readonly dispatcherFactory: DispatcherFactory = buildDispatcher
  ) {
    this.endpoint = endpoint.replace(/\/+$/, "");
  }

  private ensure(): Dispatcher {
    this.dispatcher ??= this.dispatcherFactory();
    return this.dispatcher;
  }

  async close(): Promise<void> {
    this.closed = true;
    const dispatcher = this.dispatcher;
    this.dispatcher = null;
    if (dispatcher) await dispatcher.destroy().catch(() => undefined);
  }

  /** One call. Rejects on a network error or a timeout. */
  async request(method: "GET" | "POST", path: string, options: RequestOptions = {}): Promise<Reply> {
    if (this.closed) throw new Error("transport closed");
    // AbortSignal.timeout and undici take whole milliseconds only.
    const timeoutMs = Math.max(1, Math.ceil(options.timeoutMs ?? BACKGROUND_TIMEOUT_MS));
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.apiKey}`,
      "user-agent": userAgent(),
      accept: "application/json",
      ...options.headers,
    };
    let payload: string | undefined;
    if (options.body !== undefined) {
      payload = JSON.stringify(options.body);
      headers["content-type"] = "application/json";
    }
    const response = await this.ensure().request({
      origin: this.endpoint,
      path,
      method,
      headers,
      body: payload,
      signal: AbortSignal.timeout(timeoutMs),
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
    });
    return readReply(response);
  }

  /** The decide call: null when it fails or misses the deadline (DNS included). Never rejects. */
  async requestWithDeadline(method: "GET" | "POST", path: string, body: unknown, deadlineMs = DECIDE_DEADLINE_MS): Promise<Reply | null> {
    if (this.closed) return null;
    try {
      return await this.request(method, path, { body, timeoutMs: deadlineMs });
    } catch {
      return null;
    }
  }
}
