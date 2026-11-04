/** The real @google-cloud/bigquery client → our hook → a local router and a local BigQuery. */
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { BigQuery } from "@google-cloud/bigquery";
import { OAuth2Client } from "google-auth-library";
import * as sdk from "../src/bigquery/index.js";
import * as top from "../src/index.js";
import { current } from "../src/core/runtime.js";
import { RES, serve, type TestServer } from "./helpers.js";

const DECISION_ID = "d1-k1-abc-001122334455-aabbccddeeff";
const state = { rejectReservation: false, refuseReservation: false };
let router: TestServer;
let bq: TestServer;
let client: BigQuery;

function fakeAuth(): OAuth2Client {
  const auth = new OAuth2Client();
  auth.setCredentials({ access_token: "test-token", expiry_date: Date.now() + 3600_000 });
  return auth;
}

before(async () => {
  router = await serve((_method, path) => {
    if (path === "/v1/config") return [200, { policies: [{ projects: [], mode: "active", sendParamValues: true }], pollSeconds: 60 }];
    if (path === "/v1/decide") {
      return [
        200,
        {
          decisionId: DECISION_ID,
          action: "set_reservation",
          reservation: RES,
          labels: { slashpeak_route: `m_${DECISION_ID}` },
          ttlSeconds: 60,
          cacheScope: "none",
          mode: "active",
          explanation: {},
        },
      ];
    }
    return [200, { accepted: 1 }];
  });
  bq = await serve((method, path, body) => {
    if (method === "POST" && path.endsWith("/jobs")) {
      if (body.configuration.reservation && state.rejectReservation) {
        return [403, { error: { code: 403, message: "no", errors: [{ reason: "accessDenied", message: "no" }] } }];
      }
      if (body.configuration.reservation && state.refuseReservation) {
        return [
          200,
          {
            ...body,
            status: { state: "DONE", errorResult: { reason: "invalid", message: `User specified reservation ${RES} is not found.` } },
            statistics: { query: {} },
          },
        ];
      }
      return [200, { ...body, status: { state: "RUNNING" } }];
    }
    if (method === "POST" && path.endsWith("/queries")) {
      return [
        200,
        { jobComplete: true, totalRows: "0", rows: [], schema: { fields: [] }, jobReference: { projectId: "p", jobId: "qj1", location: "US" }, queryId: "qid" },
      ];
    }
    const job = /\/jobs\/([^/]+)$/.exec(path);
    if (method === "GET" && job) {
      return [
        200,
        {
          jobReference: { projectId: "p", jobId: job[1], location: "US" },
          configuration: { query: { query: "SELECT 1" } },
          status: { state: "DONE" },
          statistics: { reservation_id: "admin:US.etl", query: { totalBytesProcessed: "0" } },
        },
      ];
    }
    const results = /\/queries\/([^/]+)$/.exec(path);
    if (method === "GET" && results) {
      return [200, { jobComplete: true, totalRows: "0", rows: [], schema: { fields: [] }, jobReference: { projectId: "p", jobId: results[1] } }];
    }
    return [404, { error: { code: 404, message: "nope" } }];
  });
  assert.deepEqual(top.install({ apiKey: "k", endpoint: router.url }), ["bigquery"]);
  client = new BigQuery({ projectId: "p", apiEndpoint: bq.url, authClient: fakeAuth() as any, location: "US" });
});

after(async () => {
  await top.uninstall();
  await router.close();
  await bq.close();
});

beforeEach(async () => {
  await sdk.flush(1000); // events left by the test before
  state.rejectReservation = false;
  state.refuseReservation = false;
  bq.hits.length = 0;
  router.hits.length = 0;
});

const inserts = () => bq.hits.filter((h) => h.method === "POST" && h.path.endsWith("/jobs")).map((h) => h.body);
const sentEvents = () => router.hits.filter((h) => h.path === "/v1/events").flatMap((h) => h.body.events);

test("createQueryJob is routed; PII never leaves", async () => {
  const [job] = await client.createQueryJob({ query: "SELECT email FROM t WHERE email = 'ann@example.com'", jobCreationMode: "JOB_CREATION_REQUIRED" } as any);
  await job.getQueryResults();
  const [insert] = inserts();
  assert.equal(insert.configuration.reservation, RES);
  assert.match(insert.configuration.labels.slashpeak_route, /^m_/);
  const decide = router.hits.find((h) => h.path === "/v1/decide")!.body;
  assert.ok(!JSON.stringify(decide).includes("ann@example.com"));
  assert.equal(decide.jobId, insert.jobReference.jobId);
  assert.equal(decide.client.sdk, "typescript");
  await sdk.flush(1000);
  assert.deepEqual(
    sentEvents().map((e) => [e.state, e.observedReservation ?? null]),
    [
      ["submitted", null],
      // The client polls getQueryResults, which carries no reservation; the outcome join reads it from the scan.
      ["done", null],
    ]
  );
});

test("a refused reservation falls back to the original job", async () => {
  state.rejectReservation = true;
  const [job] = await client.createQueryJob({ query: "SELECT 2" });
  await job.getQueryResults();
  const [first, second] = inserts();
  assert.equal(first.configuration.reservation, RES);
  assert.equal(second.configuration.reservation, undefined);
  assert.equal(first.jobReference.jobId, second.jobReference.jobId);
  await sdk.flush(1000);
  assert.deepEqual(sentEvents().map((e) => e.state), ["fallback"]);
});

test("a deleted reservation: re-run under a new id, and the library's polls follow it", async () => {
  state.refuseReservation = true;
  const [job] = await client.createQueryJob({ query: "SELECT 5" });
  const [rows] = await job.getQueryResults();
  assert.deepEqual(rows, []);
  const [first, second] = inserts();
  assert.match(second.jobReference.jobId, new RegExp(`^${first.jobReference.jobId}_fb`));
  const gets = bq.hits.filter((h) => h.method === "GET").map((h) => h.path);
  assert.ok(gets.length > 0 && gets.every((p) => p.includes(second.jobReference.jobId)), JSON.stringify(gets));
});

test("an explicit reservation is never overridden", async () => {
  // createJob with a raw configuration works on every client version (the `reservation` option is 9.3+).
  const [job] = await client.createJob({ configuration: { query: { query: "SELECT 3" }, reservation: "projects/me/locations/US/reservations/mine" } as any });
  await job.getQueryResults();
  const [insert] = inserts();
  assert.equal(insert.configuration.reservation, "projects/me/locations/US/reservations/mine");
  assert.equal(router.hits.filter((h) => h.path === "/v1/decide").length, 0);
});

test("query() on the jobs.query path is routed", async () => {
  await client.query({ query: "SELECT 4" });
  const body = bq.hits.find((h) => h.method === "POST" && h.path.endsWith("/queries"))?.body;
  assert.ok(body, "the client used jobs.query");
  assert.equal(body.reservation, RES);
  assert.match(body.labels.slashpeak_route, /^m_/);
  await sdk.flush(1000);
  assert.deepEqual(sentEvents().map((e) => [e.state, e.jobId]), [["done", "qj1"]]);
});

test("uninstall restores the library", async () => {
  await sdk.uninstall();
  assert.equal(Object.hasOwn(BigQuery.prototype, "request"), false);
  assert.equal(current(), null);
  await client.query({ query: "SELECT 6" });
  assert.equal(router.hits.filter((h) => h.path === "/v1/decide").length, 0);
  assert.ok(sdk.install({ apiKey: "k", endpoint: router.url }));
});
