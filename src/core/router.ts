/**
 * The SDK's view of the router: decide (with breaker and cache), config poll, events.
 *
 * Everything here fails open. Any doubt means "no decision", and the job runs as
 * the caller wrote it.
 */

import { createHash } from "node:crypto";
import { VERSION } from "../version.js";
import { builtinMasker, isRecord, Masker, MaskError, maskerFromConfig } from "./mask.js";
import { isUsable, stricterMode, type Settings } from "./settings.js";
import { BACKGROUND_TIMEOUT_MS, Transport, type Reply } from "./transport.js";

export const SDK_NAME = "typescript";
export const BREAKER_FAILURES = 5;
export const BREAKER_OPEN_MS = 30_000;
export const CACHE_MAX = 2048;
export const EVENT_BATCH = 100;
export const EVENT_INTERVAL_MS = 2000;
export const EVENT_QUEUE_MAX = 5000;
export const EXIT_FLUSH_MS = 1000;
export const POLL_MIN_S = 10;
export const POLL_MAX_S = 600;
export const DEFAULT_TTL_S = 60;

export type Clock = () => number;
export type Decision = Record<string, unknown>;
export type RouterEvent = Record<string, unknown> & { decisionId: string };

const monotonic: Clock = () => performance.now();

function positiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function versionTuple(value: string): [number, number, number] {
  const parts = value
    .replace(/[+-]/g, ".")
    .split(".")
    .slice(0, 3)
    .map((piece) => {
      const digits = piece.replace(/\D/g, "");
      return digits ? Number.parseInt(digits, 10) : 0;
    });
  while (parts.length < 3) parts.push(0);
  return [parts[0]!, parts[1]!, parts[2]!];
}

/** Same rule as the server's `clientAtLeast`. */
export function clientAtLeast(version: string, minimum: unknown): boolean {
  if (typeof minimum !== "string" || !minimum) return true;
  const a = versionTuple(version);
  const b = versionTuple(minimum);
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! > b[i]!;
  }
  return true;
}

/** 5 failures in a row → open 30 s → one probe. A good probe closes it. */
export class Breaker {
  private failures = 0;
  private openedAt: number | null = null;
  private probing = false;

  constructor(private readonly clock: Clock = monotonic) {}

  allow(): boolean {
    if (this.openedAt === null) return true;
    if (this.probing || this.clock() - this.openedAt < BREAKER_OPEN_MS) return false;
    this.probing = true;
    return true;
  }

  record(ok: boolean): void {
    if (ok) {
      this.failures = 0;
      this.openedAt = null;
    } else {
      this.failures += 1;
      if (this.probing || this.failures >= BREAKER_FAILURES) this.openedAt = this.clock();
    }
    this.probing = false;
  }
}

function cacheTtlS(decision: Decision | null, capS: number): number {
  if (!decision || decision.cacheScope !== "sql") return 0;
  const ttl = positiveNumber(decision.ttlSeconds);
  return ttl === null ? 0 : Math.min(ttl, capS);
}

/** Per-process cache of decisions, key = sha256(project, location, SQL). Single-flight per key. */
export class DecisionCache {
  private readonly entries = new Map<string, { expires: number; value: Decision }>();
  private readonly flights = new Map<string, Promise<Decision | null>>();

  constructor(private readonly clock: Clock = monotonic) {}

  static key(project: string, location: string | null | undefined, sql: string): string {
    return createHash("sha256").update([project, location ?? "", sql].join("\u0000"), "utf8").digest("hex");
  }

  async getOrFetch(key: string, fetch: () => Promise<Decision | null>, ttlCapS: number): Promise<Decision | null> {
    const hit = this.entries.get(key);
    if (hit) {
      if (hit.expires > this.clock()) {
        // Refresh its place: the oldest unused entry goes first.
        this.entries.delete(key);
        this.entries.set(key, hit);
        return hit.value;
      }
      this.entries.delete(key);
    }
    // Another call is asking for the same query: share its answer (it has the same deadline).
    const flight = this.flights.get(key);
    if (flight) return flight;
    const promise = (async () => {
      let value: Decision | null = null;
      try {
        value = await fetch();
      } catch {
        value = null;
      } finally {
        this.flights.delete(key);
      }
      const ttl = cacheTtlS(value, ttlCapS);
      if (value && ttl > 0) {
        this.entries.set(key, { expires: this.clock() + ttl * 1000, value });
        while (this.entries.size > CACHE_MAX) this.entries.delete(this.entries.keys().next().value!);
      }
      return value;
    })();
    this.flights.set(key, promise);
    return promise;
  }

  clear(): void {
    this.entries.clear();
    this.flights.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

export interface RouterOptions {
  transport?: Transport;
  clock?: Clock;
  /** Background timers (config poll, event flush). Tests turn them off. */
  timers?: boolean;
}

/** Process-wide router state. */
export class Router {
  readonly settings: Settings;
  readonly transport: Transport;
  readonly breaker: Breaker;
  readonly cache: DecisionCache;
  private configValue: Record<string, unknown> | null = null;
  private etag: string | null = null;
  private maskerValue: Masker | null = builtinMasker();
  private events: RouterEvent[] = [];
  private started = false;
  private closed = false;
  private readonly timers: boolean;
  private configTimer: NodeJS.Timeout | null = null;
  private eventTimer: NodeJS.Timeout | null = null;
  private sending: Promise<void> = Promise.resolve();

  constructor(settings: Settings, options: RouterOptions = {}) {
    this.settings = settings;
    const clock = options.clock ?? monotonic;
    this.transport = options.transport ?? new Transport(settings.endpoint, settings.apiKey ?? "");
    this.breaker = new Breaker(clock);
    this.cache = new DecisionCache(clock);
    this.timers = options.timers ?? true;
  }

  // -- background timers -----------------------------------------------------------------
  /** Starts the config poll and the event flush once. Timers never keep the process alive. */
  start(): void {
    if (this.started || this.closed) return;
    this.started = true;
    if (!this.timers) return;
    void this.configLoop();
    this.eventTimer = setInterval(() => void this.sendQueued(), EVENT_INTERVAL_MS);
    this.eventTimer.unref();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  async close(flushMs: number = EXIT_FLUSH_MS): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.configTimer) clearTimeout(this.configTimer);
    if (this.eventTimer) clearInterval(this.eventTimer);
    if (flushMs > 0) await this.flushEvents(flushMs);
    await this.transport.close();
  }

  // -- config ----------------------------------------------------------------------------
  /** One `GET /v1/config` with ETag. True when the call worked (200 or 304). */
  async pollConfig(): Promise<boolean> {
    const headers: Record<string, string> = this.etag ? { "if-none-match": this.etag } : {};
    let reply: Reply;
    try {
      reply = await this.transport.request("GET", "/v1/config", { headers });
    } catch {
      return false;
    }
    if (reply.status === 304) return true;
    if (reply.status !== 200 || reply.body === null) return false;
    this.applyConfig(reply);
    return true;
  }

  private applyConfig(reply: Reply): void {
    const config = reply.body ?? {};
    let masker: Masker | null;
    try {
      masker = maskerFromConfig(config.mask) ?? builtinMasker();
    } catch (error) {
      if (!(error instanceof MaskError)) throw error;
      masker = null; // A rule this SDK cannot compile: send nothing until it changes.
    }
    this.configValue = config;
    this.etag = reply.etag;
    this.maskerValue = masker;
  }

  pollSeconds(): number {
    const value = this.configValue?.pollSeconds;
    if (typeof value === "number" && Number.isFinite(value)) return Math.max(POLL_MIN_S, Math.min(POLL_MAX_S, value));
    return 60;
  }

  private async configLoop(): Promise<void> {
    if (this.closed) return;
    const ok = await this.pollConfig();
    if (this.closed) return;
    const wait = ok ? this.pollSeconds() : POLL_MIN_S;
    // Jitter, so a fleet of workers started together does not poll together.
    this.configTimer = setTimeout(() => void this.configLoop(), wait * 1000 * (0.9 + Math.random() * 0.2));
    this.configTimer.unref();
  }

  masker(): Masker | null {
    return this.maskerValue;
  }

  config(): Record<string, unknown> | null {
    return this.configValue;
  }

  // -- gating ----------------------------------------------------------------------------
  /** Policies that may cover `project`; null when no config has arrived yet. */
  private policiesFor(project: string): Array<Record<string, unknown>> | null {
    const config = this.configValue;
    if (config === null) return null;
    const policies = Array.isArray(config.policies) ? config.policies.filter(isRecord) : [];
    return policies.filter((policy) => {
      const projects = Array.isArray(policy.projects) ? policy.projects : [];
      // An empty list covers every project of that connection (the server's rule).
      return projects.length === 0 || projects.includes(project);
    });
  }

  mayDecide(project: string): boolean {
    if (this.closed || !isUsable(this.settings)) return false;
    const config = this.configValue;
    if (config === null) return true; // First calls before the config arrives: the server still applies every rule.
    if (config.killSwitch === true) return false;
    const minimum = isRecord(config.minClient) ? config.minClient[SDK_NAME] : undefined;
    if (!clientAtLeast(VERSION, minimum)) return false;
    return (this.policiesFor(project) ?? []).some((policy) => stricterMode(this.settings.mode, policy.mode) !== "off");
  }

  sendParamValues(project: string): boolean {
    if (!this.settings.sendParamValues) return false;
    // Off if any policy that may cover the project says off.
    return (this.policiesFor(project) ?? []).every((policy) => policy.sendParamValues !== false);
  }

  ttlCapS(): number {
    return positiveNumber(this.configValue?.decisionTtlSeconds) ?? DEFAULT_TTL_S;
  }

  // -- decide ----------------------------------------------------------------------------
  decide(cacheKey: string, request: Record<string, unknown>): Promise<Decision | null> {
    this.start();
    return this.cache.getOrFetch(cacheKey, () => this.decideCall(request), this.ttlCapS());
  }

  private async decideCall(request: Record<string, unknown>): Promise<Decision | null> {
    if (!this.breaker.allow()) return null;
    const reply = await this.transport.requestWithDeadline("POST", "/v1/decide", request);
    const ok = reply !== null && reply.status === 200 && reply.body !== null;
    this.breaker.record(ok);
    return ok ? reply.body : null;
  }

  // -- events ----------------------------------------------------------------------------
  emit(event: Record<string, unknown>): void {
    if (typeof event.decisionId !== "string" || !event.decisionId || this.closed) return;
    this.start();
    // Bounded: events are best effort and never slow a job.
    if (this.events.length < EVENT_QUEUE_MAX) this.events.push(event as RouterEvent);
  }

  get queuedEvents(): number {
    return this.events.length;
  }

  private drain(limit: number): RouterEvent[] {
    return this.events.splice(0, limit);
  }

  private async sendBatch(batch: RouterEvent[], timeoutMs: number): Promise<void> {
    if (batch.length === 0) return;
    try {
      await this.transport.request("POST", "/v1/events", { body: { events: batch }, timeoutMs });
    } catch {
      // Dropped: events are best effort.
    }
  }

  /** The timer's flush: one at a time, every queued batch. */
  private sendQueued(): Promise<void> {
    this.sending = this.sending.then(async () => {
      while (this.events.length > 0) {
        const batch = this.drain(EVENT_BATCH);
        await this.sendBatch(batch, BACKGROUND_TIMEOUT_MS);
        if (batch.length < EVENT_BATCH) break;
      }
    });
    return this.sending;
  }

  /** Sends queued events for at most `deadlineMs`. */
  async flushEvents(deadlineMs: number = EXIT_FLUSH_MS): Promise<void> {
    const end = performance.now() + deadlineMs;
    while (this.events.length > 0) {
      const left = end - performance.now();
      if (left <= 0) return;
      await this.sendBatch(this.drain(EVENT_BATCH), Math.max(50, left));
    }
  }
}
