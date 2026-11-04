/**
 * SlashPeak Job Router hook for `@google-cloud/bigquery`.
 *
 * ```ts
 * import * as slashpeakBigQuery from "slashpeak/bigquery";
 * slashpeakBigQuery.install();              // every BigQuery client in this process
 * // or: slashpeakBigQuery.wrap(bigquery);  // one client
 * ```
 *
 * `install()` from `slashpeak` does the same for every supported library installed.
 */

import { createRequire } from "node:module";
import * as runtime from "../core/runtime.js";
import { isUsable, loadSettings, makeSettings, type Settings, type SettingsInput } from "../core/settings.js";
import { setLibraryAgent } from "../core/transport.js";
import { guard, Hook, type RequestFn } from "./hook.js";

export type { Settings, SettingsInput } from "../core/settings.js";

export const NAME = "bigquery";
export const LIBRARY = "@google-cloud/bigquery";
const MARK = Symbol.for("slashpeak.hooked");
const require = createRequire(import.meta.url);

const hook = new Hook(runtime.current);
let patched: { proto: Record<string, unknown>; hadOwn: boolean; original: RequestFn } | null = null;

/** Explicit settings win; anything left out comes from the environment. */
export function resolveSettings(input?: SettingsInput): Settings | undefined {
  return input === undefined ? undefined : makeSettings({ ...loadSettings(), ...input });
}

function wrapper(original: RequestFn): RequestFn {
  const request = function (this: unknown, reqOpts: unknown, callback?: unknown): unknown {
    return hook.handle(original, this, reqOpts, callback);
  };
  Object.defineProperty(request, MARK, { value: true });
  Object.defineProperty(request, "__wrapped__", { value: original });
  return request;
}

function isHooked(fn: unknown): boolean {
  return typeof fn === "function" && (fn as unknown as Record<symbol, unknown>)[MARK] === true;
}

function noteLibrary(): void {
  try {
    const { version } = require(`${LIBRARY}/package.json`) as { version?: string };
    if (version) setLibraryAgent(`${LIBRARY}/${version}`);
  } catch {
    // The User-Agent then names only the SDK.
  }
}

/** Hooks every BigQuery client in this process. True when the hook is on. */
export function install(settings?: SettingsInput): boolean {
  const router = runtime.acquire(NAME, resolveSettings(settings));
  if (!isUsable(router.settings)) return false;
  // Loaded here, not at import: `slashpeak` installs without it.
  const { BigQuery } = require(LIBRARY) as { BigQuery: { prototype: Record<string, unknown> } };
  const proto = BigQuery.prototype;
  const current = proto.request as RequestFn;
  if (!isHooked(current)) {
    patched = { proto, hadOwn: Object.hasOwn(proto, "request"), original: current };
    proto.request = wrapper(current);
  }
  noteLibrary();
  router.start();
  return true;
}

/** Hooks one `BigQuery` client only. Returns the same client. */
export function wrap<T extends object>(client: T, settings?: SettingsInput): T {
  const router = runtime.acquire(NAME, resolveSettings(settings));
  if (!isUsable(router.settings)) return client;
  const target = client as unknown as Record<string, unknown>;
  if (!isHooked(target.request)) {
    target.request = wrapper(Object.getPrototypeOf(client).request as RequestFn);
  }
  router.start();
  return client;
}

/** Removes the hook. The shared router closes (events flushed, at most 1 s) when no hook is left. */
export async function uninstall(): Promise<void> {
  if (patched !== null) {
    const { proto, hadOwn, original } = patched;
    if (hadOwn) proto.request = original;
    else delete proto.request;
    patched = null;
  }
  await runtime.release(NAME);
}

/** Runs `fn` with the hook off for everything it starts (for example, a job that must never move). */
export function bypass<T>(fn: () => T): T {
  return guard.run(true, fn);
}

/** Sends queued events now, for at most `timeoutMs`. */
export const flush = runtime.flush;
