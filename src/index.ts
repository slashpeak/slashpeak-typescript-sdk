/**
 * SlashPeak Job Router: run each warehouse job where it costs less.
 *
 * ```ts
 * import * as slashpeak from "slashpeak";
 * slashpeak.install(); // hooks every supported library that is installed
 * ```
 *
 * Reads `SLASHPEAK_API_KEY`, `SLASHPEAK_MODE` (off | shadow | active),
 * `SLASHPEAK_ENDPOINT` and `SLASHPEAK_SEND_PARAM_VALUES`. Without a key it
 * does nothing. On any error, or no answer within 500 ms, jobs run unchanged.
 */

import { createRequire } from "node:module";
import * as bigquery from "./bigquery/index.js";
import { flush as flushEvents } from "./core/runtime.js";
import type { SettingsInput } from "./core/settings.js";

export { VERSION } from "./version.js";
export { loadSettings, type Mode, type Settings, type SettingsInput } from "./core/settings.js";

const require = createRequire(import.meta.url);

/** Warehouse hook → the library it needs. */
const HOOKS = [{ name: bigquery.NAME, library: bigquery.LIBRARY, hook: bigquery }] as const;

function has(library: string): boolean {
  try {
    require.resolve(library);
    return true;
  } catch {
    return false;
  }
}

/** Hooks every supported library that is installed. Returns the hooks that are on. */
export function install(settings?: SettingsInput): string[] {
  const on: string[] = [];
  for (const { name, library, hook } of HOOKS) {
    if (has(library) && hook.install(settings)) on.push(name);
  }
  return on;
}

/** Removes every hook and flushes pending events (at most 1 s). */
export async function uninstall(): Promise<void> {
  for (const { hook } of HOOKS) await hook.uninstall();
}

/** Sends queued events now, for at most `timeoutMs` (default 1 s). Call it before `process.exit()` or at the end of a serverless handler. */
export function flush(timeoutMs?: number): Promise<void> {
  return flushEvents(timeoutMs);
}
