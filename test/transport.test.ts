/** Connection behaviour against a real local HTTP/1.1 server. */
import assert from "node:assert/strict";
import { createServer, type Socket } from "node:net";
import { test } from "node:test";
import { DECIDE_DEADLINE_MS, MAX_RESPONSE_BYTES, Transport } from "../src/core/transport.js";
import { serve, tick } from "./helpers.js";

// undici may open a second socket while the first answer's body is still being read; both stay warm.
test("keep-alive reuses warm connections (no handshake per call)", async () => {
  const server = await serve(() => [200, { ok: true }]);
  const transport = new Transport(server.url, "k");
  for (let i = 0; i < 10; i++) assert.equal((await transport.request("GET", "/v1/health")).status, 200);
  assert.ok(server.connections <= 2, `${server.connections} connections`);
  await transport.close();
  await server.close();
});

test("decide calls reuse pooled connections", async () => {
  const server = await serve(() => [200, { ok: true }]);
  const transport = new Transport(server.url, "k");
  for (let i = 0; i < 10; i++) assert.equal((await transport.requestWithDeadline("POST", "/v1/decide", { a: i }))?.status, 200);
  assert.ok(server.connections <= 2, `${server.connections} connections`);
  await transport.close();
  await server.close();
});

test("the key is only in the header; JSON body sent; cookies ignored", async () => {
  const server = await serve(() => [200, { ok: true }]);
  const transport = new Transport(server.url, "secret-key");
  await transport.request("POST", "/v1/events", { body: { events: [1] } });
  await transport.request("GET", "/v1/health");
  const [first, second] = server.hits;
  assert.equal(first!.headers.authorization, "Bearer secret-key");
  assert.equal(first!.headers["content-type"], "application/json");
  assert.deepEqual(first!.body, { events: [1] });
  assert.ok(!first!.path.includes("secret"));
  assert.match(String(first!.headers["user-agent"]), /^slashpeak-typescript\//);
  assert.equal(second!.headers.cookie, undefined);
  await transport.close();
  await server.close();
});

test("the deadline bounds a slow router", async () => {
  const server = await serve(async () => {
    await tick(2000);
    return [200, { ok: true }];
  });
  const transport = new Transport(server.url, "k");
  const started = performance.now();
  assert.equal(await transport.requestWithDeadline("POST", "/v1/decide", {}), null);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < DECIDE_DEADLINE_MS + 250, `took ${elapsed} ms`);
  await transport.close();
  await server.close();
});

test("the deadline covers a router that accepts and never answers", async () => {
  const sockets = new Set<Socket>();
  const blackhole = createServer((socket) => void sockets.add(socket));
  await new Promise<void>((resolve) => blackhole.listen(0, "127.0.0.1", resolve));
  const { port } = blackhole.address() as { port: number };
  const transport = new Transport(`http://127.0.0.1:${port}`, "k");
  const started = performance.now();
  assert.equal(await transport.requestWithDeadline("POST", "/v1/decide", {}), null);
  assert.ok(performance.now() - started < DECIDE_DEADLINE_MS + 250);
  await transport.close();
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => blackhole.close(() => resolve()));
});

test("an unreachable router fails within the deadline", async () => {
  // Port 9 on localhost: nothing listens, the connect is refused at once.
  const transport = new Transport("http://127.0.0.1:9", "k");
  const started = performance.now();
  assert.equal(await transport.requestWithDeadline("POST", "/v1/decide", {}), null);
  assert.ok(performance.now() - started < DECIDE_DEADLINE_MS + 250);
  await transport.close();
});

test("no retries on 5xx", async () => {
  const server = await serve(() => [503, { error: {} }]);
  const transport = new Transport(server.url, "k");
  assert.equal((await transport.requestWithDeadline("POST", "/v1/decide", {}))?.status, 503);
  assert.equal(server.hits.length, 1);
  await transport.close();
  await server.close();
});

test("no redirects", async () => {
  const server = await serve(
    () => [200, {}],
    (_req, res) => {
      res.writeHead(302, { location: "http://127.0.0.1:1/elsewhere", "content-length": 0 });
      res.end();
      return true;
    }
  );
  const transport = new Transport(server.url, "k");
  const reply = await transport.request("GET", "/v1/config");
  assert.equal(reply.status, 302);
  assert.equal(server.hits.length, 1);
  await transport.close();
  await server.close();
});

test("a big response is dropped", async () => {
  const server = await serve(() => [200, { pad: "x".repeat(MAX_RESPONSE_BYTES) }]);
  const transport = new Transport(server.url, "k");
  const reply = await transport.request("GET", "/v1/config");
  assert.equal(reply.status, 200);
  assert.equal(reply.body, null);
  await transport.close();
  await server.close();
});

test("a closed transport fails open", async () => {
  const transport = new Transport("http://127.0.0.1:9", "k");
  await transport.close();
  assert.equal(await transport.requestWithDeadline("POST", "/v1/decide", {}), null);
  await assert.rejects(transport.request("GET", "/v1/health"));
});
