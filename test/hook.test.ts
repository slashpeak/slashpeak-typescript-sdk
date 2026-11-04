import assert from "node:assert/strict";
import { test } from "node:test";
import { Hook, type Callback, type RequestFn } from "../src/bigquery/hook.js";
import { bypass } from "../src/bigquery/index.js";
import type { Router } from "../src/core/router.js";
import { decision, FakeTransport, insertBody, makeRouter, MOVE, ok, RES } from "./helpers.js";

class FakeError extends Error {
  constructor(
    readonly code: number,
    reason = "",
    message = "error"
  ) {
    super(message);
    this.errors = reason ? [{ reason, message }] : [];
  }
  errors: Array<Record<string, string>>;
}

/** Stands in for `BigQuery`: records what reaches `request`, answers from a queue. */
class FakeBigQuery {
  projectId = "p";
  packageJson = { version: "9.6.0" };
  sent: Array<{ method?: string; uri: string; json?: any; projectId?: string }> = [];
  failWith: Error[] = [];
  responses: unknown[] = [];
  throwSync: Error | null = null;

  request(reqOpts: any, callback: Callback): void {
    if (this.throwSync) throw this.throwSync;
    this.sent.push({ method: reqOpts.method, uri: reqOpts.uri, json: reqOpts.json === undefined ? undefined : JSON.parse(JSON.stringify(reqOpts.json)) });
    setImmediate(() => {
      if (this.failWith.length > 0) return callback(this.failWith.shift()!, null);
      if (this.responses.length > 0) return callback(null, this.responses.shift());
      if (reqOpts.uri === "/jobs") return callback(null, { jobReference: reqOpts.json?.jobReference, status: { state: "RUNNING" } });
      callback(null, { jobReference: { projectId: "p", jobId: "q1" }, jobComplete: false });
    });
  }
}

const original = FakeBigQuery.prototype.request as unknown as RequestFn;

function call(hook: Hook, bq: FakeBigQuery, reqOpts: Record<string, unknown>): Promise<{ error: unknown; body: any }> {
  return new Promise((resolve) => {
    hook.handle(original, bq, reqOpts, (error: unknown, body: unknown) => resolve({ error, body }));
  });
}

function setup(settings = {}): { router: Router; transport: FakeTransport; hook: Hook; bq: FakeBigQuery } {
  const { router, transport } = makeRouter(settings);
  return { router, transport, hook: new Hook(() => router), bq: new FakeBigQuery() };
}

async function events(router: Router, transport: FakeTransport): Promise<any[]> {
  const before = transport.events().length;
  await router.flushEvents(1000);
  return transport.events().slice(before);
}

const insert = (json: Record<string, unknown> = insertBody()) => ({ method: "POST", uri: "/jobs", json });

test("active move sets the reservation and the label; the caller's object is unchanged", async () => {
  const { router, transport, hook, bq } = setup();
  transport.decideReplies = [ok(MOVE)];
  const body = insertBody();
  const before = structuredClone(body);
  await call(hook, bq, insert(body));
  const sent = bq.sent[0]!.json.configuration;
  assert.equal(sent.reservation, RES);
  assert.equal(sent.labels.slashpeak_route, MOVE.labels && (MOVE.labels as any).slashpeak_route);
  assert.deepEqual(body, before);
  assert.deepEqual((await events(router, transport)).map((e) => e.state), ["submitted"]);
  const request = transport.decides()[0]!.body as any;
  assert.equal(request.jobId, "job_1");
  assert.equal(request.client.library, "@google-cloud/bigquery/9.6.0");
});

test("shadow: label only", async () => {
  const { transport, hook, bq } = setup();
  transport.decideReplies = [ok(decision({ mode: "shadow", label: "s_d1-x" }))];
  await call(hook, bq, insert());
  const sent = bq.sent[0]!.json.configuration;
  assert.equal("reservation" in sent, false);
  assert.deepEqual(sent.labels, { slashpeak_route: "s_d1-x" });
});

test("SDK in shadow never moves and drops the move label", async () => {
  const { transport, hook, bq } = setup({ mode: "shadow" });
  transport.decideReplies = [ok(MOVE)];
  await call(hook, bq, insert());
  assert.deepEqual(bq.sent[0]!.json, insertBody());
});

test("jobs that skip the router", async () => {
  const cases: Array<Record<string, unknown>> = [
    insert({ ...insertBody(), configuration: { query: { query: "SELECT 1" }, reservation: "projects/a/locations/US/reservations/mine" } }),
    insert({ ...insertBody(), configuration: { query: { query: "SELECT 1" }, dryRun: true } }),
    insert({ ...insertBody(), configuration: { query: { query: "SELECT 1", continuous: true } } }),
    insert({ jobReference: { jobId: "j" }, configuration: { load: { sourceUris: ["gs://x"] } } }),
    { method: "POST", uri: "/queries", json: { query: "SELECT 1", reservation: "projects/a/locations/US/reservations/mine" } },
    { method: "POST", uri: "/queries", json: { query: "SELECT 1", dryRun: true } },
    { method: "POST", uri: "/datasets", json: { datasetReference: {} } },
    { uri: "/jobs" },
    { method: "POST", uri: "https://other.example/jobs", json: insertBody() },
  ];
  for (const reqOpts of cases) {
    const { transport, hook, bq } = setup();
    await call(hook, bq, reqOpts);
    assert.equal(transport.decides().length, 0, JSON.stringify(reqOpts));
    assert.equal(bq.sent.length, 1);
  }
});

test("a job id is set when none is set", async () => {
  const { transport, hook, bq } = setup();
  transport.decideReplies = [ok(decision())];
  await call(hook, bq, insert({ configuration: { query: { query: "SELECT 1" } } }));
  const jobId = bq.sent[0]!.json.jobReference.jobId;
  assert.match(jobId, /^slashpeak_[0-9a-f]{32}$/);
  assert.equal((transport.decides()[0]!.body as any).jobId, jobId);
});

test("no answer runs the original", async () => {
  const { router, transport, hook, bq } = setup();
  transport.decideReplies = [null];
  await call(hook, bq, insert());
  assert.deepEqual(bq.sent[0]!.json, insertBody());
  assert.deepEqual(await events(router, transport), []);
});

test("a 4xx on a changed request falls back once, with the same job id", async () => {
  const { router, transport, hook, bq } = setup();
  transport.decideReplies = [ok(MOVE)];
  bq.failWith = [new FakeError(403, "accessDenied")];
  const { error } = await call(hook, bq, insert(insertBody("SELECT 'ann@example.com'")));
  assert.equal(error, null);
  assert.equal(bq.sent.length, 2);
  const [first, second] = bq.sent.map((s) => s.json);
  assert.equal(first.jobReference.jobId, second.jobReference.jobId);
  assert.deepEqual(second, insertBody("SELECT 'ann@example.com'"));
  const [event, ...rest] = await events(router, transport);
  assert.equal(rest.length, 0);
  assert.equal(event.state, "fallback");
  assert.equal(event.errorReason, "accessDenied");
  assert.ok(!JSON.stringify(event).includes("ann@example.com"));
});

function refusedJob(body: Record<string, any>, message = "User specified reservation projects/admin/locations/US/reservations/etl is not found.") {
  return {
    jobReference: body.jobReference,
    status: { state: "DONE", errorResult: { reason: "invalid", message } },
    statistics: { creationTime: "1", startTime: "2", endTime: "2", query: {} },
  };
}

test("a job failed for a missing reservation re-runs the original under a new job id; later calls follow it", async () => {
  const { router, transport, hook, bq } = setup();
  transport.decideReplies = [ok(MOVE)];
  bq.responses = [refusedJob(insertBody())];
  const { body } = await call(hook, bq, insert());
  assert.equal(bq.sent.length, 2);
  const retry = bq.sent[1]!.json;
  assert.equal("reservation" in retry.configuration, false);
  assert.equal("labels" in retry.configuration, false);
  assert.match(retry.jobReference.jobId, /^job_1_fb[0-9a-f]{8}$/);
  assert.equal(body.jobReference.jobId, retry.jobReference.jobId);
  const [event] = await events(router, transport);
  assert.equal(event.state, "fallback");
  assert.equal(event.errorReason, "reservation_refused");
  assert.equal(event.jobId, retry.jobReference.jobId);
  // The library still holds the old id: its polls, results and cancel go to the new job.
  await call(hook, bq, { uri: "jobs/job_1", qs: { location: "US" } });
  await call(hook, bq, { uri: "/queries/job_1" });
  await call(hook, bq, { method: "POST", uri: "/jobs/job_1/cancel" });
  assert.deepEqual(
    bq.sent.slice(2).map((s) => s.uri),
    [`jobs/${retry.jobReference.jobId}`, `/queries/${retry.jobReference.jobId}`, `/jobs/${retry.jobReference.jobId}/cancel`]
  );
});

test("other failed jobs are not re-run", async () => {
  const responses = [
    // The query ran and failed on its own (a SQL error): never re-run, it could bill twice.
    { status: { state: "DONE", errorResult: { reason: "invalidQuery", message: "Syntax error" } }, statistics: {} },
    // An error that names the reservation but the query ran (statistics filled).
    { status: { state: "DONE", errorResult: { reason: "invalid", message: "reservation busy" } }, statistics: { query: { totalBytesProcessed: "10" } } },
    // Other refusals that do not name the reservation (for example max_slots) are left alone.
    { status: { state: "DONE", errorResult: { reason: "invalid", message: "max_slots field is not yet supported." } }, statistics: {} },
  ];
  for (const response of responses) {
    const { router, transport, hook, bq } = setup();
    transport.decideReplies = [ok(MOVE)];
    bq.responses = [{ jobReference: insertBody().jobReference, ...response }];
    await call(hook, bq, insert());
    assert.equal(bq.sent.length, 1);
    assert.deepEqual((await events(router, transport)).map((e) => e.state), ["failed"]);
  }
});

test("a refused reservation on an unchanged request is left alone", async () => {
  const { transport, hook, bq } = setup();
  transport.decideReplies = [ok(decision())];
  bq.responses = [refusedJob(insertBody())];
  await call(hook, bq, insert());
  assert.equal(bq.sent.length, 1);
});

test("jobs.query without a job reports the queryId", async () => {
  const { router, transport, hook, bq } = setup();
  transport.decideReplies = [ok(decision({ mode: "shadow", label: "s_d1-x" }))];
  bq.responses = [{ queryId: "abc%1a1a22f7106", jobComplete: true }];
  await call(hook, bq, { method: "POST", uri: "/queries", json: { query: "SELECT 1", location: "US", jobCreationMode: "JOB_CREATION_OPTIONAL" } });
  const [event] = await events(router, transport);
  assert.equal(event.state, "done");
  assert.equal(event.jobId, "abc%1a1a22f7106");
});

test("no fallback on conflict, rate limit or 5xx", async () => {
  for (const code of [409, 429, 500, 503]) {
    const { router, transport, hook, bq } = setup();
    transport.decideReplies = [ok(MOVE)];
    bq.failWith = [new FakeError(code)];
    const { error } = await call(hook, bq, insert());
    assert.equal((error as FakeError).code, code);
    assert.equal(bq.sent.length, 1);
    assert.deepEqual((await events(router, transport)).map((e) => e.state), ["insert_error"]);
  }
});

test("a 4xx on an unchanged request goes to the caller", async () => {
  const { transport, hook, bq } = setup();
  transport.decideReplies = [ok(decision())];
  bq.failWith = [new FakeError(400)];
  const { error } = await call(hook, bq, insert());
  assert.equal((error as FakeError).code, 400);
  assert.equal(bq.sent.length, 1);
});

test("jobs.query: top-level fields, and a new requestId on fallback", async () => {
  const { router, transport, hook, bq } = setup();
  transport.decideReplies = [ok(decision({ action: "set_reservation", reservation: RES, label: "m_d1-x" }))];
  bq.failWith = [new FakeError(403, "accessDenied", "Access Denied: Reservation projects/admin/locations/US/reservations/etl")];
  await call(hook, bq, { method: "POST", uri: "/queries", json: { query: "SELECT 1", requestId: "req-1", location: "US" } });
  assert.equal(bq.sent[0]!.json.reservation, RES);
  assert.deepEqual(bq.sent[0]!.json.labels, { slashpeak_route: "m_d1-x" });
  assert.equal("reservation" in bq.sent[1]!.json, false);
  assert.notEqual(bq.sent[1]!.json.requestId, "req-1");
  const [event] = await events(router, transport);
  assert.equal(event.state, "fallback");
  assert.equal(event.requestId, "req-1");
  assert.equal(event.jobId, "q1");
});

test("jobs.query never re-runs a query that ran (a 4xx that does not name our change)", async () => {
  const { router, transport, hook, bq } = setup();
  transport.decideReplies = [ok(decision({ action: "set_reservation", reservation: RES, label: "m_d1-x" }))];
  bq.failWith = [new FakeError(400, "invalidQuery", "Syntax error: Unexpected keyword")];
  const { error } = await call(hook, bq, { method: "POST", uri: "/queries", json: { query: "SELECT", requestId: "req-1" } });
  assert.equal((error as FakeError).code, 400);
  assert.equal(bq.sent.length, 1);
  assert.deepEqual((await events(router, transport)).map((e) => e.state), ["insert_error"]);
});

test("no label when the job already has 64", async () => {
  const { transport, hook, bq } = setup();
  transport.decideReplies = [ok(decision({ mode: "shadow", label: "s_d1-x" }))];
  const labels = Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`k${i}`, "v"]));
  const body = insertBody();
  (body.configuration as any).labels = labels;
  await call(hook, bq, insert(body));
  assert.deepEqual(bq.sent[0]!.json.configuration.labels, labels);
});

test("a bad reservation or label is ignored", async () => {
  const { transport, hook, bq } = setup();
  transport.decideReplies = [ok(decision({ action: "set_reservation", reservation: "none", label: "M_BAD LABEL" }))];
  await call(hook, bq, insert());
  assert.deepEqual(bq.sent[0]!.json, insertBody());
});

test("done state from a GET the library makes, reported once", async () => {
  const { router, transport, hook, bq } = setup();
  transport.decideReplies = [ok(MOVE)];
  await call(hook, bq, insert());
  assert.deepEqual((await events(router, transport)).map((e) => e.state), ["submitted"]);
  const done = { status: { state: "DONE" }, statistics: { reservation_id: "admin:US.etl" } };
  bq.responses = [done];
  await call(hook, bq, { uri: "jobs/job_1", qs: { location: "US" } });
  const [event, ...rest] = await events(router, transport);
  assert.equal(rest.length, 0);
  assert.equal(event.state, "done");
  assert.equal(event.observedReservation, "admin:US.etl");
  assert.equal(event.jobId, "job_1");
  bq.responses = [done];
  await call(hook, bq, { uri: "jobs/job_1" });
  assert.deepEqual(await events(router, transport), []);
});

test("failed state", async () => {
  const { router, transport, hook, bq } = setup();
  transport.decideReplies = [ok(decision({ mode: "shadow", label: "s_d1-x" }))];
  bq.responses = [{ jobReference: { jobId: "job_1" }, status: { state: "DONE", errorResult: { reason: "invalid query!" } } }];
  await call(hook, bq, insert());
  const [event] = await events(router, transport);
  assert.equal(event.state, "failed");
  assert.equal(event.errorReason, "invalidquery");
});

test("a kill-switch decision has no events", async () => {
  const { router, transport, hook, bq } = setup();
  transport.decideReplies = [ok(decision({ decisionId: null, scope: "none" }))];
  await call(hook, bq, insert());
  assert.deepEqual(await events(router, transport), []);
});

test("a router error never breaks the job", async () => {
  const { router, hook, bq } = setup();
  router.decide = () => {
    throw new Error("boom");
  };
  const { error } = await call(hook, bq, insert());
  assert.equal(error, null);
  assert.deepEqual(bq.sent[0]!.json, insertBody());
});

test("a library that throws at once gives the error to the caller", async () => {
  const { transport, hook, bq } = setup();
  transport.decideReplies = [ok(decision())];
  bq.throwSync = new Error("bad options");
  const { error } = await call(hook, bq, insert());
  assert.equal((error as Error).message, "bad options");
});

test("bypass skips the hook", async () => {
  const { transport, hook, bq } = setup();
  await bypass(() => call(hook, bq, insert()));
  assert.equal(transport.decides().length, 0);
  assert.equal(bq.sent.length, 1);
});

test("the cache reuses a decision", async () => {
  const { transport, hook, bq } = setup();
  transport.defaultDecide = ok(MOVE);
  await call(hook, bq, insert());
  await call(hook, bq, insert({ ...insertBody(), jobReference: { projectId: "p", jobId: "job_2", location: "US" } }));
  assert.equal(transport.decides().length, 1);
  assert.equal(bq.sent[1]!.json.configuration.reservation, RES);
});

test("the library's project placeholder is resolved from the credentials", async () => {
  const { transport, hook, bq } = setup();
  transport.decideReplies = [ok(MOVE)];
  bq.projectId = "{{projectId}}";
  (bq as any).getProjectId = async () => "real-project";
  await call(hook, bq, insert({ ...insertBody(), jobReference: { projectId: "{{projectId}}", jobId: "job_1" } }));
  assert.equal((transport.decides()[0]!.body as any).projectId, "real-project");
  assert.equal(bq.sent[0]!.json.configuration.reservation, RES);
});

test("no callback, or a non-object request, passes straight through", async () => {
  const { transport, hook, bq } = setup();
  let returned: unknown;
  bq.request = ((reqOpts: unknown) => {
    returned = reqOpts;
    return "stream";
  }) as any;
  assert.equal(hook.handle(bq.request as unknown as RequestFn, bq, insert(), undefined), "stream");
  assert.deepEqual(returned, insert());
  assert.equal(transport.decides().length, 0);
});
