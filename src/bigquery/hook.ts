/**
 * The hook on `BigQuery.prototype.request` (`@google-cloud/bigquery`).
 *
 * One point covers `query`, `createQueryJob`, `createJob`, `createQueryStream`
 * and the jobs.query fast path. Rules (plan: "SDKs"):
 *
 * - Never make a job fail that would have run. Any error in the SDK → the
 *   caller's request, unchanged.
 * - Never override an explicit `reservation`. Never touch dry runs, load,
 *   copy, extract or continuous jobs.
 * - Set a client job id when none is set, so retries dedupe and the outcome
 *   check can find the job.
 * - After a 4xx at insert on a changed request (never 408, 409 or 429), run the
 *   original request once, then report `fallback`. Never re-send a changed
 *   request after a 5xx or a timeout. jobs.insert can also answer 200 with a job
 *   that failed at once because the reservation is not found (nothing ran):
 *   run the original once under a new job id, and send the library's later
 *   calls for the old id (job polls, results, cancel) to the new one.
 * - A move to on-demand (`reservation: none`, jobs.query only) carries a bytes
 *   cap. If BigQuery stops the job on that cap (before it bills), run the
 *   original once, then report `fallback`.
 * - Never change the caller's object: the hook sends copies.
 * - Read job state only from responses the library already fetches. No extra
 *   BigQuery calls.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes, randomUUID } from "node:crypto";
import { isRecord } from "../core/mask.js";
import { DecisionCache, type Decision, type Router } from "../core/router.js";
import { stricterMode } from "../core/settings.js";
import { buildDecideRequest, type RequestKind } from "./requestBody.js";

export const LABEL_KEY = "slashpeak_route";
export const MAX_LABELS = 64;
export const PENDING_MAX = 10_000;
export const PENDING_TTL_MS = 24 * 3600 * 1000;
/** The library's placeholder until it knows the project from the credentials. */
export const PROJECT_TOKEN = "{{projectId}}";
const PROJECT_WAIT_MS = 500;

const LABEL_VALUE = /^[a-z0-9_-]{1,63}$/;
const RESERVATION = /^projects\/[^/]+\/locations\/[^/]+\/reservations\/[^/]+$/;
const JOB_GET = /^\/?jobs\/([^/?]+)\/?$/;
const RESULTS_GET = /^\/?queries\/([^/?]+)\/?$/;
const JOB_URI = /^(\/?(?:jobs|queries)\/)([^/?]+)(.*)$/s;
const REASON = /[^A-Za-z0-9_.-]/g;
/** 4xx codes that do not come from our change: timeout, conflict (job exists), rate limit. */
const NO_FALLBACK = new Set([408, 409, 429]);
/**
 * jobs.query reports a query that ran and failed as a 4xx too, so a re-run there could bill twice.
 * It re-runs only when BigQuery names a field we changed. The message is read here, never sent or logged.
 */
const OUR_FIELDS = /reservation|label/i;
/** The job's `reservation` value that runs it on-demand. */
const ON_DEMAND = "none";
const BYTES_CAP = /^\d{1,19}$/;
/** BigQuery's reason when `maximumBytesBilled` stops a job; it checks before the job bills. */
export const BYTES_CAP_REASON = "bytesBilledLimitExceeded";

export type Callback = (error: unknown, body?: unknown, response?: unknown) => void;
export type RequestFn = (this: unknown, reqOpts: unknown, callback?: unknown) => unknown;
type Json = Record<string, unknown>;

/** `bypass()` turns the hook off for everything started inside it. */
export const guard = new AsyncLocalStorage<boolean>();

export function reasonOf(error: unknown): string {
  let reason: unknown = null;
  if (isRecord(error)) {
    const errors = error.errors;
    if (Array.isArray(errors) && isRecord(errors[0])) reason = errors[0].reason;
    if (typeof reason !== "string" || !reason) {
      reason = typeof error.code === "number" ? `http_${error.code}` : null;
    }
  }
  if (typeof reason !== "string" || !reason) reason = error instanceof Error ? error.name : "error";
  return String(reason).replace(REASON, "").slice(0, 64);
}

export function statusCode(error: unknown): number | null {
  const code = isRecord(error) || error instanceof Error ? (error as { code?: unknown }).code : null;
  return typeof code === "number" && Number.isInteger(code) ? code : null;
}

function errorText(error: unknown): string {
  try {
    const parts: string[] = [];
    if (error instanceof Error) parts.push(error.message);
    const errors = isRecord(error) || error instanceof Error ? (error as { errors?: unknown }).errors : null;
    if (Array.isArray(errors)) {
      for (const item of errors) if (isRecord(item)) parts.push(String(item.message ?? ""), String(item.reason ?? ""));
    }
    return parts.join(" ");
  } catch {
    return "";
  }
}

/**
 * jobs.insert: a 4xx means no job was made. jobs.query: only when the error names our change, or
 * when the bytes cap we set stopped it (BigQuery checks the cap before the job bills).
 */
export function mayFallBack(kind: RequestKind, code: number | null, error: unknown, capped = false): boolean {
  if (code === null || code < 400 || code >= 500 || NO_FALLBACK.has(code)) return false;
  if (capped && reasonOf(error) === BYTES_CAP_REASON) return true;
  return kind === "insert" || OUR_FIELDS.test(errorText(error));
}

/** True when the hook set `maximumBytesBilled` (the original had none). */
export function addedBytesCap(kind: RequestKind, base: Json, changed: Json | null): boolean {
  if (changed === null) return false;
  const holder = (json: Json): unknown => {
    const target = kind === "insert" ? json.configuration : json;
    const query = kind === "insert" && isRecord(target) ? target.query : target;
    return isRecord(query) ? query.maximumBytesBilled : undefined;
  };
  return holder(base) == null && holder(changed) != null;
}

/** A bounded, short-lived map by job id, oldest first. */
class TimedMap<V> {
  private readonly items = new Map<string, { at: number; value: V }>();

  get size(): number {
    return this.items.size;
  }

  set(key: string, value: V): void {
    const now = Date.now();
    this.items.delete(key);
    this.items.set(key, { at: now, value });
    for (const [oldest, item] of this.items) {
      if (this.items.size <= PENDING_MAX && now - item.at <= PENDING_TTL_MS) break;
      this.items.delete(oldest);
    }
  }

  get(key: string): V | undefined {
    return this.items.get(key)?.value;
  }

  pop(key: string): V | undefined {
    const item = this.items.get(key);
    this.items.delete(key);
    return item?.value;
  }
}

interface Pre {
  kind: RequestKind;
  json: Json;
  project: string;
}

interface Plan {
  kind: RequestKind;
  project: string;
  base: Json;
  request: Json;
  cacheKey: string;
}

function method(reqOpts: Json): string {
  return typeof reqOpts.method === "string" ? reqOpts.method.toUpperCase() : "GET";
}

function relativeUri(reqOpts: Json): string | null {
  const uri = reqOpts.uri;
  return typeof uri === "string" && !/^https?:/i.test(uri) ? uri : null;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      }
    );
  });
}

export class Hook {
  /** Routed jobs waiting for a DONE state, by job id. */
  readonly pending = new TimedMap<Json>();
  /** Job id → the id its original request was re-run under (missing reservation). */
  readonly aliases = new TimedMap<string>();

  constructor(private readonly routerGetter: () => Router | null) {}

  // -- entry -----------------------------------------------------------------------------
  handle(original: RequestFn, self: unknown, reqOpts: unknown, callback: unknown): unknown {
    if (guard.getStore() === true || typeof callback !== "function" || !isRecord(reqOpts)) {
      return original.call(self, reqOpts, callback);
    }
    const opts = this.aliases.size > 0 ? this.rewriteAlias(reqOpts) : reqOpts;
    const done = callback as Callback;
    const router = this.routerGetter();
    let pre: Pre | null = null;
    if (router !== null) {
      try {
        pre = this.prePlan(router, self, opts);
      } catch {
        pre = null;
      }
    }
    if (router === null || pre === null) {
      return original.call(self, opts, router !== null && this.pending.size > 0 ? this.observer(router, opts, done) : done);
    }
    void this.run(router, original, self, opts, done, pre);
    return undefined;
  }

  /** Sends the library's later calls for a re-run job (polls, results, cancel) to the new job id. */
  private rewriteAlias(reqOpts: Json): Json {
    const uri = relativeUri(reqOpts);
    const match = uri === null ? null : JOB_URI.exec(uri);
    const target = match ? this.aliases.get(match[2]!) : undefined;
    return match && target ? { ...reqOpts, uri: `${match[1]}${target}${match[3]}` } : reqOpts;
  }

  // -- plan ------------------------------------------------------------------------------
  /** The checks that need no waiting. */
  private prePlan(router: Router, self: unknown, reqOpts: Json): Pre | null {
    if (method(reqOpts) !== "POST") return null;
    const uri = relativeUri(reqOpts);
    const json = reqOpts.json;
    if (uri === null || !isRecord(json)) return null;
    const path = uri.replace(/^\/+|\/+$/g, "");
    let kind: RequestKind;
    if (path === "jobs") kind = "insert";
    else if (path === "queries") kind = "query";
    else return null;
    if (kind === "insert") {
      const configuration = json.configuration;
      if (!isRecord(configuration) || !isRecord(configuration.query)) return null; // load, copy, extract
      if (configuration.dryRun || configuration.query.continuous || configuration.reservation) return null;
    } else if (json.dryRun || json.continuous || json.reservation) {
      return null;
    }
    const project = typeof reqOpts.projectId === "string" && reqOpts.projectId ? reqOpts.projectId : (self as { projectId?: unknown }).projectId;
    if (typeof project !== "string" || !project) return null;
    if (project !== PROJECT_TOKEN && !router.mayDecide(project)) return null;
    if (router.masker() === null) return null;
    return { kind, json, project };
  }

  private async plan(router: Router, self: unknown, pre: Pre): Promise<Plan | null> {
    let project: string | null = pre.project;
    if (project === PROJECT_TOKEN) {
      // The library learns the project from the credentials; it caches the answer.
      const getProjectId = (self as { getProjectId?: () => Promise<string> }).getProjectId;
      project = typeof getProjectId === "function" ? await withTimeout(Promise.resolve(getProjectId.call(self)), PROJECT_WAIT_MS) : null;
      if (typeof project !== "string" || !project || project === PROJECT_TOKEN || !router.mayDecide(project)) return null;
    }
    const masker = router.masker();
    if (masker === null) return null;

    const base = structuredClone(pre.json);
    let jobId: string | null = null;
    let requestId: string;
    let location: unknown;
    let sql: unknown;
    if (pre.kind === "insert") {
      base.jobReference ??= {};
      const ref = base.jobReference;
      if (!isRecord(ref)) return null;
      if (!ref.jobId) ref.jobId = `slashpeak_${randomUUID().replace(/-/g, "")}`;
      ref.projectId ??= project;
      jobId = String(ref.jobId);
      requestId = randomUUID().replace(/-/g, "");
      location = ref.location;
      sql = ((base.configuration as Json).query as Json).query;
    } else {
      if (!base.requestId) base.requestId = randomUUID();
      requestId = String(base.requestId);
      location = base.location;
      sql = base.query;
    }
    const version = (self as { packageJson?: { version?: unknown } }).packageJson?.version;
    const request = buildDecideRequest({
      kind: pre.kind,
      project,
      body: base,
      masker,
      sendValues: router.sendParamValues(project),
      requestId,
      jobId,
      library: typeof version === "string" ? `@google-cloud/bigquery/${version}` : "@google-cloud/bigquery",
    });
    if (request === null || typeof sql !== "string") return null;
    return {
      kind: pre.kind,
      project,
      base,
      request,
      cacheKey: DecisionCache.key(project, typeof location === "string" ? location : null, sql),
    };
  }

  // -- apply -----------------------------------------------------------------------------
  /** The changed request body, or null when the decision changes nothing. */
  static apply(router: Router, kind: RequestKind, base: Json, decision: Decision): Json | null {
    const { action, reservation } = decision;
    const mode = stricterMode(router.settings.mode, decision.mode);
    // On-demand only on jobs.query: the one path that can re-run a job its bytes cap stopped.
    const onDemand = reservation === ON_DEMAND && kind === "query";
    const move =
      action === "set_reservation" && mode === "active" && typeof reservation === "string" && (RESERVATION.test(reservation) || onDemand);
    let route: unknown = isRecord(decision.labels) ? decision.labels[LABEL_KEY] : null;
    if (action === "set_reservation" && !move) route = null; // Not moved: an `m_` label would claim a move that did not happen.
    if (!(typeof route === "string" && LABEL_VALUE.test(route))) route = null;
    if (!move && route === null) return null;
    const changed = structuredClone(base);
    const target = (kind === "insert" ? changed.configuration : changed) as Json;
    if (move) target.reservation = reservation;
    const cap = decision.maximumBytesBilled;
    if (move && onDemand) {
      // A move to on-demand always comes with the cap; without one, keep the job where it is.
      if (target.maximumBytesBilled == null && !(typeof cap === "string" && BYTES_CAP.test(cap))) return null;
      if (target.maximumBytesBilled == null) target.maximumBytesBilled = cap;
    }
    if (route !== null) {
      const current: Json = isRecord(target.labels) ? { ...target.labels } : {};
      if (!(LABEL_KEY in current) && Object.keys(current).length < MAX_LABELS) {
        current[LABEL_KEY] = route;
        target.labels = current;
      } else if (!move) {
        return null;
      }
    }
    return changed;
  }

  // -- run -------------------------------------------------------------------------------
  private async run(router: Router, original: RequestFn, self: unknown, reqOpts: Json, done: Callback, pre: Pre): Promise<void> {
    let sent = false;
    let delivered = false;
    const deliver: Callback = (error, body, response) => {
      delivered = true;
      done(error, body, response);
    };
    const send = (opts: Json, callback: Callback): void => {
      sent = true;
      try {
        original.call(self, opts, callback);
      } catch (error) {
        // The library threw before answering: give the error to the caller, once.
        if (!delivered) deliver(error);
        else
          queueMicrotask(() => {
            throw error;
          });
      }
    };

    try {
      const plan = await this.plan(router, self, pre);
      if (plan === null) {
        send(reqOpts, this.pending.size > 0 ? this.observer(router, reqOpts, deliver) : deliver);
        return;
      }
      const started = performance.now();
      let decision: Decision | null = null;
      let changed: Json | null = null;
      try {
        decision = await router.decide(plan.cacheKey, plan.request);
        changed = decision ? Hook.apply(router, plan.kind, plan.base, decision) : null;
      } catch {
        changed = null;
      }
      const latencyMs = Math.round((performance.now() - started) * 10) / 10;
      const event = Hook.eventBase(plan, decision, latencyMs);
      send({ ...reqOpts, json: changed ?? plan.base }, (error, body, response) => {
        let next: (() => void) | null = null;
        try {
          next = this.afterResponse(router, reqOpts, plan, changed, event, deliver, send, error, body);
        } catch {
          next = null;
        }
        if (next) next();
        else deliver(error, body, response);
      });
    } catch {
      if (!sent) send(reqOpts, deliver);
    }
  }

  /** What to do with the answer: a fallback to run, or null to hand the answer to the caller. */
  private afterResponse(
    router: Router,
    reqOpts: Json,
    plan: Plan,
    changed: Json | null,
    event: Json | null,
    deliver: Callback,
    send: (opts: Json, callback: Callback) => void,
    error: unknown,
    body: unknown
  ): (() => void) | null {
    if (error) {
      if (changed !== null && mayFallBack(plan.kind, statusCode(error), error, addedBytesCap(plan.kind, plan.base, changed))) {
        return () => this.fallback(router, reqOpts, plan, event, deliver, send, error, false);
      }
      if (event) router.emit({ ...event, state: "insert_error", errorReason: reasonOf(error) });
      return null;
    }
    if (changed !== null && plan.kind === "insert" && refusedReservation(changed, body)) {
      return () => this.fallback(router, reqOpts, plan, event, deliver, send, null, true);
    }
    if (event) this.afterSubmit(router, plan.kind, event, body);
    return null;
  }

  /**
   * The changed request was refused before it ran: run the original once.
   *
   * `newJobId`: BigQuery made a failed job under the job id (a reservation it
   * could not find), so the original goes under a new id, and later calls for
   * the old id go to the new one.
   */
  private fallback(
    router: Router,
    reqOpts: Json,
    plan: Plan,
    event: Json | null,
    deliver: Callback,
    send: (opts: Json, callback: Callback) => void,
    error: unknown,
    newJobId: boolean
  ): void {
    const body = structuredClone(plan.base);
    // jobs.query dedupes on requestId; a fresh one makes sure BigQuery runs the original.
    if (plan.kind === "query") body.requestId = randomUUID();
    if (newJobId) {
      const ref = body.jobReference as Json;
      const oldId = String(ref.jobId);
      const rerunId = `${oldId.slice(0, 1000)}_fb${randomBytes(4).toString("hex")}`;
      ref.jobId = rerunId;
      this.aliases.set(oldId, rerunId);
    }
    const fallback: Json | null = event ? { ...event, state: "fallback", errorReason: error ? reasonOf(error) : "reservation_refused" } : null;
    send({ ...reqOpts, json: body }, (error2, body2, response2) => {
      try {
        if (fallback) {
          const jobId = isRecord(body2) && isRecord(body2.jobReference) ? body2.jobReference.jobId : null;
          if (!error2 && typeof jobId === "string") fallback.jobId = jobId;
          router.emit(fallback);
        }
      } catch {
        // Events never break a job.
      }
      deliver(error2, body2, response2);
    });
  }

  // -- events ----------------------------------------------------------------------------
  static eventBase(plan: Plan, decision: Decision | null, latencyMs: number): Json | null {
    const decisionId = decision?.decisionId;
    if (typeof decisionId !== "string" || !decisionId) return null;
    const event: Json = {
      decisionId: decisionId.slice(0, 64),
      requestId: plan.request.requestId,
      decideLatencyMs: Math.max(0, Math.min(latencyMs, 600_000)),
    };
    if (plan.request.jobId) event.jobId = plan.request.jobId;
    return event;
  }

  private afterSubmit(router: Router, kind: RequestKind, event: Json, response: unknown): void {
    try {
      if (!isRecord(response)) {
        router.emit({ ...event, state: "submitted" });
        return;
      }
      let jobId: unknown = isRecord(response.jobReference) ? response.jobReference.jobId : null;
      // jobs.query with optional job creation: no job, and INFORMATION_SCHEMA.JOBS lists the run under its queryId.
      if (!jobId && kind === "query") jobId = response.queryId;
      let withJob = event;
      if (typeof jobId === "string" && jobId) withJob = { ...event, jobId: jobId.slice(0, 256) };
      const final = finalState(kind, response);
      if (final !== null) {
        router.emit({ ...withJob, ...final });
        return;
      }
      router.emit({ ...withJob, state: "submitted" });
      if (typeof jobId === "string" && jobId) this.pending.set(jobId, withJob);
    } catch {
      // Events never break a job.
    }
  }

  private observer(router: Router, reqOpts: Json, done: Callback): Callback {
    return (error, body, response) => {
      if (!error) this.observe(router, reqOpts, body);
      done(error, body, response);
    };
  }

  /** A GET the library made anyway: report a routed job's final state. */
  private observe(router: Router, reqOpts: Json, response: unknown): void {
    try {
      if (method(reqOpts) !== "GET" || !isRecord(response)) return;
      const uri = relativeUri(reqOpts);
      if (uri === null) return;
      let kind: RequestKind | "results" = "insert";
      let match = JOB_GET.exec(uri);
      if (!match) {
        match = RESULTS_GET.exec(uri);
        kind = "results";
      }
      if (!match) return;
      const final = finalState(kind, response);
      if (final === null) return;
      const event = this.pending.pop(decodeURIComponent(match[1]!));
      if (event) router.emit({ ...event, ...final });
    } catch {
      // Events never break a job.
    }
  }
}

/**
 * jobs.insert answered 200 with a job that failed at once because of the reservation we set.
 *
 * BigQuery makes such a job when the reservation is not found (checked 2026-11-03):
 * state DONE, an error naming the reservation, and no query statistics, so nothing
 * ran or billed. The message is read here, never sent or logged.
 */
export function refusedReservation(changed: Json, response: unknown): boolean {
  const configuration = changed.configuration;
  if (!isRecord(configuration) || !configuration.reservation || !isRecord(response)) return false;
  const status = response.status;
  if (!isRecord(status) || status.state !== "DONE") return false;
  const error = status.errorResult;
  if (!isRecord(error) || error.reason !== "invalid") return false;
  if (!/\breservation\b/i.test(String(error.message ?? ""))) return false;
  const stats = response.statistics;
  const query = isRecord(stats) ? stats.query : null;
  return !(isRecord(query) && (query.totalBytesProcessed || query.totalSlotMs));
}

/** done / failed from a response, or null while the job still runs. */
export function finalState(kind: RequestKind | "results", response: Json): Json | null {
  if (kind === "insert") {
    const status = response.status;
    if (!isRecord(status) || status.state !== "DONE") return null;
    let out: Json = { state: "done" };
    const error = status.errorResult;
    if (isRecord(error)) out = { state: "failed", errorReason: String(error.reason || "error").replace(REASON, "").slice(0, 64) };
    const observed = isRecord(response.statistics) ? response.statistics.reservation_id : null;
    if (typeof observed === "string" && observed) out.observedReservation = observed.slice(0, 512);
    return out;
  }
  // jobs.query and getQueryResults: `jobComplete`; a failed query comes back as an error instead.
  return response.jobComplete === true ? { state: "done" } : null;
}
