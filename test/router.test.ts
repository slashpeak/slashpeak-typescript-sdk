import assert from "node:assert/strict";
import { test } from "node:test";
import { Breaker, BREAKER_FAILURES, BREAKER_OPEN_MS, clientAtLeast, DecisionCache, EVENT_BATCH } from "../src/core/router.js";
import { endpointIsSafe, isUsable, loadSettings, makeSettings, stricterMode } from "../src/core/settings.js";
import { decision, FakeTransport, makeRouter, ok, tick } from "./helpers.js";

test("breaker opens after 5 failures, then lets one probe through", () => {
  let now = 0;
  const breaker = new Breaker(() => now);
  for (let i = 0; i < BREAKER_FAILURES; i++) {
    assert.equal(breaker.allow(), true);
    breaker.record(false);
  }
  assert.equal(breaker.allow(), false);
  now += BREAKER_OPEN_MS;
  assert.equal(breaker.allow(), true);
  assert.equal(breaker.allow(), false, "only one probe");
  breaker.record(false);
  assert.equal(breaker.allow(), false, "a failed probe opens it again");
  now += BREAKER_OPEN_MS;
  assert.equal(breaker.allow(), true);
  breaker.record(true);
  assert.equal(breaker.allow(), true);
});

test("decide failures trip the breaker", async () => {
  const { router, transport } = makeRouter();
  for (let i = 0; i < BREAKER_FAILURES + 3; i++) assert.equal(await router.decide(`k${i}`, {}), null);
  assert.equal(transport.decides().length, BREAKER_FAILURES);
});

test("a non-200 answer is a failure and is not cached", async () => {
  const { router, transport } = makeRouter();
  transport.decideReplies = [{ status: 429, body: { error: {} }, etag: null }, ok(decision())];
  assert.equal(await router.decide("k", {}), null);
  assert.deepEqual(await router.decide("k", {}), decision());
  assert.equal(transport.decides().length, 2);
});

test("cache: TTL, scope and cap", async () => {
  let now = 0;
  const { router, transport } = makeRouter({}, new FakeTransport(), () => now);
  transport.defaultDecide = ok(decision({ ttl: 600 }));
  await router.decide("a", {});
  await router.decide("a", {});
  assert.equal(transport.decides().length, 1);
  now += 61_000; // capped at 60 s (no config yet)
  await router.decide("a", {});
  assert.equal(transport.decides().length, 2);
  transport.defaultDecide = ok(decision({ scope: "none" }));
  await router.decide("b", {});
  await router.decide("b", {});
  assert.equal(transport.decides().length, 4);
  transport.defaultDecide = ok({ ...decision(), ttlSeconds: "60" });
  await router.decide("c", {});
  await router.decide("c", {});
  assert.equal(transport.decides().length, 6, "a bad TTL is not cached");
});

test("cache: one call for many waiters (single flight)", async () => {
  const cache = new DecisionCache();
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const fetch = async () => {
    calls += 1;
    await gate;
    return decision();
  };
  const all = Promise.all([1, 2, 3, 4, 5].map(() => cache.getOrFetch("k", fetch, 60)));
  release();
  const answers = await all;
  assert.equal(calls, 1);
  assert.ok(answers.every((a) => a?.decisionId));
});

test("cache key covers project, location and SQL", () => {
  assert.notEqual(DecisionCache.key("p", "US", "SELECT 1"), DecisionCache.key("p", "EU", "SELECT 1"));
  assert.notEqual(DecisionCache.key("p", null, "SELECT 1"), DecisionCache.key("q", null, "SELECT 1"));
  assert.equal(DecisionCache.key("p", null, "x"), DecisionCache.key("p", "", "x"));
});

test("gating from config", async () => {
  const { router, transport } = makeRouter();
  assert.equal(router.mayDecide("p"), true, "before the first config");
  const apply = async (body: Record<string, unknown>) => {
    transport.configReply = { status: 200, body, etag: null };
    await router.pollConfig();
  };
  await apply({ policies: [{ projects: ["p"], mode: "shadow" }] });
  assert.equal(router.mayDecide("p"), true);
  assert.equal(router.mayDecide("other"), false);
  await apply({ policies: [{ projects: [], mode: "off" }] });
  assert.equal(router.mayDecide("p"), false);
  await apply({ policies: [{ projects: [], mode: "active" }], killSwitch: true });
  assert.equal(router.mayDecide("p"), false);
  await apply({ policies: [{ projects: [], mode: "active" }], minClient: { typescript: "99.0.0", python: "0.0.1" } });
  assert.equal(router.mayDecide("p"), false);
  await apply({ policies: [{ projects: [], mode: "active" }], minClient: { python: "99.0.0" } });
  assert.equal(router.mayDecide("p"), true, "another SDK's minimum is not ours");
  const { router: off } = makeRouter({ mode: "off" });
  assert.equal(off.mayDecide("p"), false);
});

test("parameter values: off if the SDK or any covering policy says off", async () => {
  const { router, transport } = makeRouter();
  assert.equal(router.sendParamValues("p"), true);
  transport.configReply = { status: 200, body: { policies: [{ projects: [], mode: "active", sendParamValues: false }] }, etag: null };
  await router.pollConfig();
  assert.equal(router.sendParamValues("p"), false);
  assert.equal(makeRouter({ sendParamValues: false }).router.sendParamValues("p"), false);
});

test("a mask rule this SDK cannot compile stops sending", async () => {
  const { router, transport } = makeRouter();
  transport.configReply = { status: 200, body: { mask: { revision: "r2", rules: [{ pattern: "(", token: "<x>" }] } }, etag: null };
  await router.pollConfig();
  assert.equal(router.masker(), null);
  transport.configReply = { status: 200, body: { mask: { revision: "r3", rules: [{ pattern: "a", token: "<x>" }] } }, etag: null };
  await router.pollConfig();
  assert.equal(router.masker()?.revision, "r3");
});

test("config poll sends the ETag; 304 keeps the config", async () => {
  const { router, transport } = makeRouter();
  transport.configReply = { status: 200, body: { pollSeconds: 30 }, etag: '"v1"' };
  assert.equal(await router.pollConfig(), true);
  transport.configReply = { status: 304, body: null, etag: null };
  assert.equal(await router.pollConfig(), true);
  const configCalls = transport.calls.filter((c) => c.path === "/v1/config");
  assert.deepEqual(configCalls[1]!.headers, { "if-none-match": '"v1"' });
  assert.equal(router.pollSeconds(), 30);
});

test("poll seconds are bounded", async () => {
  const { router, transport } = makeRouter();
  for (const [value, expected] of [
    [1, 10],
    [10_000, 600],
    ["x", 60],
  ] as const) {
    transport.configReply = { status: 200, body: { pollSeconds: value }, etag: null };
    await router.pollConfig();
    assert.equal(router.pollSeconds(), expected);
  }
});

test("events: batched, bounded, flushed", async () => {
  const { router, transport } = makeRouter();
  for (let i = 0; i < EVENT_BATCH + 5; i++) router.emit({ decisionId: `d${i}`, state: "submitted" });
  router.emit({ state: "submitted" }); // no decision id: dropped
  await router.flushEvents(1000);
  const posts = transport.calls.filter((c) => c.path === "/v1/events");
  assert.deepEqual(
    posts.map((p) => (p.body as { events: unknown[] }).events.length),
    [EVENT_BATCH, 5]
  );
  await router.close();
  router.emit({ decisionId: "late", state: "done" });
  assert.equal(router.queuedEvents, 0);
  assert.equal(transport.closed, true);
});

test("settings and modes", () => {
  const settings = loadSettings({ SLASHPEAK_API_KEY: " k ", SLASHPEAK_MODE: "Shadow", SLASHPEAK_ENDPOINT: "https://r.example/", SLASHPEAK_SEND_PARAM_VALUES: "off" });
  assert.deepEqual({ ...settings }, { apiKey: "k", endpoint: "https://r.example", mode: "shadow", sendParamValues: false });
  assert.equal(loadSettings({ SLASHPEAK_API_KEY: "k", SLASHPEAK_MODE: "actve" }).mode, "off", "a typo means off");
  assert.equal(loadSettings({}).apiKey, null);
  assert.equal(isUsable(loadSettings({})), false);
  assert.equal(isUsable(makeSettings({ apiKey: "k" })), true);
  assert.equal(isUsable(makeSettings({ apiKey: "k", endpoint: "http://router.example" })), false);
  assert.equal(endpointIsSafe("http://127.0.0.1:9"), true);
  assert.equal(endpointIsSafe("http://[::1]:9"), true);
  assert.equal(endpointIsSafe("ftp://x"), false);
  assert.equal(stricterMode("active", "shadow"), "shadow");
  assert.equal(stricterMode("active", undefined), "off");
  assert.equal(stricterMode("active", "active"), "active");
});

test("clientAtLeast", () => {
  assert.equal(clientAtLeast("0.1.2", "0.1.2"), true);
  assert.equal(clientAtLeast("0.1.10", "0.1.9"), true);
  assert.equal(clientAtLeast("0.1.1", "0.1.2"), false);
  assert.equal(clientAtLeast("1.0.0-rc.1", "1.0.0"), true);
  assert.equal(clientAtLeast("0.1.0", undefined), true);
});

test("TTL cap ignores bad values", async () => {
  const { router, transport } = makeRouter();
  for (const value of [0, -5, "30", null]) {
    transport.configReply = { status: 200, body: { decisionTtlSeconds: value }, etag: null };
    await router.pollConfig();
    assert.equal(router.ttlCapS(), 60);
  }
  transport.configReply = { status: 200, body: { decisionTtlSeconds: 15 }, etag: null };
  await router.pollConfig();
  assert.equal(router.ttlCapS(), 15);
});

test("timers never keep the process alive", async () => {
  const transport = new FakeTransport();
  const { Router } = await import("../src/core/router.js");
  const router = new Router(makeSettings({ apiKey: "k" }), { transport: transport as any });
  router.start();
  await tick(10);
  assert.ok(transport.calls.some((c) => c.path === "/v1/config"), "the first poll runs at start");
  await router.close(0);
});
