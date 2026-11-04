/** Requests the SDK builds must fit the router's OpenAPI contract (spec/openapi.json). */
import assert from "node:assert/strict";
import { test } from "node:test";
import { builtinMasker } from "../src/core/mask.js";
import { buildDecideRequest, type RequestKind } from "../src/bigquery/requestBody.js";
import { insertBody, loadSpec } from "./helpers.js";

const OPENAPI = loadSpec("openapi.json");
const DECIDE = OPENAPI.paths["/v1/decide"].post.requestBody.content["application/json"].schema;

function typeOk(kind: string | string[] | undefined, value: unknown): boolean {
  if (kind === undefined) return true;
  const kinds = Array.isArray(kind) ? kind : [kind];
  return kinds.some((k) => {
    if (k === "null") return value === null;
    if (k === "object") return typeof value === "object" && value !== null && !Array.isArray(value);
    if (k === "array") return Array.isArray(value);
    if (k === "integer") return Number.isInteger(value);
    return typeof value === k;
  });
}

function check(schema: any, value: unknown, where = "$"): void {
  if ("const" in schema) assert.equal(value, schema.const, where);
  if (schema.enum) assert.ok(schema.enum.includes(value), where);
  assert.ok(typeOk(schema.type, value), `${where} type`);
  if (schema.properties && typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? []) assert.ok(key in record, `${where}.${key} missing`);
    for (const [key, item] of Object.entries(record)) {
      if (key in schema.properties) check(schema.properties[key], item, `${where}.${key}`);
      else if (typeof schema.additionalProperties === "object") check(schema.additionalProperties, item, `${where}.${key}`);
      else assert.fail(`${where}.${key} is not in the contract`);
    }
  }
  if (Array.isArray(value)) {
    assert.ok(value.length <= (schema.maxItems ?? Infinity), where);
    value.forEach((item, i) => check(schema.items ?? {}, item, `${where}[${i}]`));
  }
  if (typeof value === "string") {
    assert.ok(value.length <= (schema.maxLength ?? Infinity), where);
    assert.ok(value.length >= (schema.minLength ?? 0), where);
  }
}

function build(options: { kind?: RequestKind; body?: Record<string, unknown>; sendValues?: boolean; jobId?: string | null; project?: string } = {}) {
  return buildDecideRequest({
    kind: options.kind ?? "insert",
    project: options.project ?? "p",
    body: options.body ?? insertBody(),
    masker: builtinMasker(),
    sendValues: options.sendValues ?? true,
    requestId: "r1",
    jobId: options.jobId === undefined ? "job_1" : options.jobId,
    library: "@google-cloud/bigquery/9.6.0",
  });
}

test("insert request fits the contract and is masked", () => {
  const body = insertBody("SELECT * FROM `p.d.t` WHERE email = 'ann@example.com' AND x = @v", {
    parameterMode: "NAMED",
    queryParameters: [
      { name: "v", parameterType: { type: "STRING" }, parameterValue: { value: "bob@example.com" } },
      { name: "a", parameterType: { type: "ARRAY" }, parameterValue: { arrayValues: [{ value: "10.0.0.1" }] } },
    ],
    priority: "BATCH",
    defaultDataset: { projectId: "p", datasetId: "d" },
    destinationTable: { projectId: "p", datasetId: "d", tableId: "out" },
    maximumBytesBilled: 1000,
    connectionProperties: [{ key: "session_id", value: "s" }],
  });
  (body.configuration as Record<string, unknown>).labels = { team: "bi" };
  const request = build({ body })!;
  check(DECIDE, request);
  const query = request.query as any;
  assert.equal(query.sql, "SELECT * FROM `p.d.t` WHERE email = '<email>' AND x = @v");
  assert.equal(query.parameters[0].value, "<email>");
  assert.deepEqual(query.parameters[1].value, ["<ip>"]);
  assert.equal(query.hasSessionId, true);
  assert.equal(query.maximumBytesBilled, "1000");
  assert.deepEqual(query.labels, { team: "bi" });
  assert.equal(request.location, "US");
  assert.equal(request.jobId, "job_1");
  assert.deepEqual(request.client, { sdk: "typescript", version: (request.client as any).version, library: "@google-cloud/bigquery/9.6.0" });
});

test("query path request fits the contract", () => {
  const body = { query: "SELECT 1", location: "EU", requestId: "r1", labels: { a: "b" }, useLegacySql: false, reservation: undefined };
  const request = build({ kind: "query", body, jobId: null })!;
  check(DECIDE, JSON.parse(JSON.stringify(request)));
  assert.equal("jobId" in request, false);
  assert.equal(request.location, "EU");
});

test("values are not sent when off", () => {
  const body = insertBody("SELECT @v", { queryParameters: [{ name: "v", parameterType: { type: "STRING" }, parameterValue: { value: "x" } }] });
  const request = build({ body, sendValues: false })!;
  assert.deepEqual((request.query as any).parameters, [{ name: "v", type: "STRING" }]);
});

test("jobs that are not routed", () => {
  assert.equal(build({ body: insertBody("/* slashpeak:off */ SELECT 1") }), null);
  assert.equal(build({ body: insertBody("/*SlashPeak : OFF*/ SELECT 1") }), null);
  assert.equal(build({ body: insertBody("   ") }), null);
  // Over 256 KiB the router would keep it unread, so the SDK does not send it.
  assert.equal(build({ body: insertBody("SELECT '" + "x".repeat(256 * 1024) + "'") }), null);
  assert.notEqual(build({ body: insertBody("SELECT '" + "x".repeat(200 * 1024) + "'") }), null);
  // Bytes, not characters.
  assert.equal(build({ body: insertBody("SELECT '" + "é".repeat(130 * 1024) + "'") }), null);
  assert.equal(build({ project: "p".repeat(200) }), null);
});
