/**
 * The one router per process, shared by every warehouse hook.
 *
 * A process that uses BigQuery and Snowflake keeps one key, one connection pool,
 * one config poll and one event queue. The state lives on `globalThis`, so two
 * copies of this package in one process still share it.
 */

import { Router, EXIT_FLUSH_MS } from "./router.js";
import { loadSettings, sameSettings, type Settings } from "./settings.js";

interface RuntimeState {
  router: Router | null;
  users: Set<string>;
  exitHooked: boolean;
}

const KEY = Symbol.for("slashpeak.runtime.v1");
const holder = globalThis as unknown as { [KEY]?: RuntimeState };
const state: RuntimeState = (holder[KEY] ??= { router: null, users: new Set(), exitHooked: false });

export function current(): Router | null {
  return state.router;
}

function hookExit(): void {
  if (state.exitHooked) return;
  state.exitHooked = true;
  // `beforeExit` runs when the event loop is empty (a normal end, not `process.exit()`).
  // Flush once, for at most 1 s; it fires again after, with an empty queue.
  process.on("beforeExit", () => {
    const router = state.router;
    if (router && router.queuedEvents > 0) void router.flushEvents(EXIT_FLUSH_MS);
  });
}

/** The process router for one hook (`bigquery`, …). New settings replace the router. */
export function acquire(user: string, settings?: Settings): Router {
  const existing = state.router;
  // Same settings from a second hook keep the router (one pool, one poll, one queue).
  if (existing === null || existing.isClosed || (settings !== undefined && !sameSettings(settings, existing.settings))) {
    if (existing !== null) void existing.close(0);
    state.router = new Router(settings ?? loadSettings());
  }
  hookExit();
  state.users.add(user);
  return state.router!;
}

/** Closes the router (flushing events, at most 1 s) when its last hook goes. */
export async function release(user: string): Promise<void> {
  state.users.delete(user);
  const router = state.router;
  if (state.users.size > 0 || router === null) return;
  state.router = null;
  await router.close();
}

/** Sends queued events now, for at most `timeoutMs`. Call it before `process.exit()` or at the end of a serverless handler. */
export async function flush(timeoutMs: number = EXIT_FLUSH_MS): Promise<void> {
  await state.router?.flushEvents(timeoutMs);
}
