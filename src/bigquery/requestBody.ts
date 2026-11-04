/**
 * Builds the `/v1/decide` body from a BigQuery REST request body.
 *
 * Two request shapes reach the hook:
 *
 * - `POST /projects/{p}/jobs` (jobs.insert): `configuration.query` …
 * - `POST /projects/{p}/queries` (jobs.query): `query`, `location` … at the top level.
 *
 * Only masked SQL and masked string parameter values leave the process.
 */

import { isRecord, type Masker } from "../core/mask.js";
import { SDK_NAME } from "../core/router.js";
import { VERSION } from "../version.js";

export const API_VERSION = 1;
/** SQL over this is never sent: the router keeps it unread (masking cost grows with size). */
export const MAX_SQL_BYTES = 256 * 1024;
export const MAX_PARAMS = 1000;
/** `/* slashpeak:off *\/` anywhere in the SQL opts the job out (same rule as the server). */
export const OPT_OUT = /\/\*\s*slashpeak\s*:\s*off\s*\*\//i;

export type RequestKind = "insert" | "query";

const encoder = new TextEncoder();
const byteLength = (text: string): number => encoder.encode(text).length;

function short(value: unknown, limit: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= limit ? value : null;
}

function paramValue(parameter: Record<string, unknown>, masker: Masker): unknown {
  const value = parameter.parameterValue;
  if (!isRecord(value)) return null;
  if ("value" in value) {
    const raw = value.value;
    return typeof raw === "string" ? masker.mask(raw) : (raw ?? null);
  }
  if (Array.isArray(value.arrayValues)) {
    return value.arrayValues.slice(0, MAX_PARAMS).map((item) => {
      const raw = isRecord(item) ? item.value : null;
      return typeof raw === "string" ? masker.mask(raw) : (raw ?? null);
    });
  }
  return null; // STRUCT values are not sent.
}

function parameters(raw: unknown, masker: Masker, sendValues: boolean): Array<Record<string, unknown>> | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: Array<Record<string, unknown>> = [];
  for (const parameter of raw.slice(0, MAX_PARAMS)) {
    if (!isRecord(parameter)) continue;
    const entry: Record<string, unknown> = {};
    const name = short(parameter.name, 128);
    const kind = short(isRecord(parameter.parameterType) ? parameter.parameterType.type : null, 64);
    if (name) entry.name = name;
    if (kind) entry.type = kind;
    if (sendValues) entry.value = paramValue(parameter, masker);
    out.push(entry);
  }
  return out;
}

function cleanLabels(raw: unknown): Record<string, string> | null {
  if (!isRecord(raw)) return null;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string" && value.length <= 63) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

const TABLE_LIMITS: Record<string, number> = { projectId: 128, datasetId: 1024, tableId: 1024 };

function table(raw: unknown, keys: string[]): Record<string, string> | null {
  if (!isRecord(raw)) return null;
  const out: Record<string, string> = {};
  for (const key of keys) {
    const value = short(raw[key], TABLE_LIMITS[key]!);
    if (value) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** The query block: `configuration.query` for jobs.insert, the body itself for jobs.query. */
export function queryOf(kind: RequestKind, body: Record<string, unknown>): Record<string, unknown> | null {
  if (kind === "query") return body;
  const configuration = body.configuration;
  return isRecord(configuration) && isRecord(configuration.query) ? configuration.query : null;
}

export function sqlOf(kind: RequestKind, body: Record<string, unknown>): string | null {
  const sql = queryOf(kind, body)?.query;
  return typeof sql === "string" && sql.trim() ? sql : null;
}

export interface DecideInput {
  kind: RequestKind;
  project: string;
  body: Record<string, unknown>;
  masker: Masker;
  sendValues: boolean;
  requestId: string;
  jobId: string | null;
  /** The warehouse library, e.g. `@google-cloud/bigquery/9.6.0`. */
  library: string;
}

/** The decide body, or null when the job is not one to route (or a field is out of bounds). */
export function buildDecideRequest(input: DecideInput): Record<string, unknown> | null {
  const { kind, project, body, masker, sendValues, requestId, jobId } = input;
  const sql = sqlOf(kind, body);
  if (sql === null || OPT_OUT.test(sql) || byteLength(sql) > MAX_SQL_BYTES) return null;
  if (!short(project, 128) || !short(requestId, 256) || (jobId !== null && !short(jobId, 256))) return null;
  const query = queryOf(kind, body)!;
  let location: unknown;
  let labels: unknown;
  let dryRun: unknown;
  if (kind === "insert") {
    const configuration = body.configuration as Record<string, unknown>;
    location = isRecord(body.jobReference) ? body.jobReference.location : undefined;
    labels = configuration.labels;
    dryRun = configuration.dryRun;
  } else {
    location = body.location;
    labels = body.labels;
    dryRun = body.dryRun;
  }

  const masked = masker.mask(sql);
  if (byteLength(masked) > MAX_SQL_BYTES) return null;
  const q: Record<string, unknown> = { sql: masked };
  for (const key of ["useLegacySql", "useQueryCache", "createSession", "continuous"]) {
    if (typeof query[key] === "boolean") q[key] = query[key];
  }
  if (typeof dryRun === "boolean") q.dryRun = dryRun;
  if (query.priority === "INTERACTIVE" || query.priority === "BATCH") q.priority = query.priority;
  const mode = short(query.parameterMode, 16);
  if (mode) q.parameterMode = mode;
  const params = parameters(query.queryParameters, masker, sendValues);
  if (params && params.length > 0) q.parameters = params;
  const maxBytes = query.maximumBytesBilled;
  if ((typeof maxBytes === "string" || (typeof maxBytes === "number" && Number.isFinite(maxBytes))) && String(maxBytes).length <= 32) {
    q.maximumBytesBilled = String(maxBytes);
  }
  const defaultDataset = table(query.defaultDataset, ["projectId", "datasetId"]);
  if (defaultDataset) q.defaultDataset = defaultDataset;
  const destination = table(query.destinationTable, ["projectId", "datasetId", "tableId"]);
  if (destination) q.destination = destination;
  const goodLabels = cleanLabels(labels);
  if (goodLabels) q.labels = goodLabels;
  const sessions = query.connectionProperties;
  if (Array.isArray(sessions) && sessions.some((p) => isRecord(p) && p.key === "session_id")) q.hasSessionId = true;
  if (query.tableDefinitions) q.hasExternalTables = true;

  const out: Record<string, unknown> = {
    apiVersion: API_VERSION,
    requestId,
    projectId: project,
    maskRevision: masker.revision,
    client: { sdk: SDK_NAME, version: VERSION, library: input.library.slice(0, 256) },
    query: q,
  };
  if (jobId) out.jobId = jobId;
  const loc = short(location, 64);
  if (loc) out.location = loc;
  return out;
}
