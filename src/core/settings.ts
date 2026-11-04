/** SDK settings, read once from the environment (or passed to `install`). */

export type Mode = "off" | "shadow" | "active";

export const MODES: readonly Mode[] = ["off", "shadow", "active"];
export const DEFAULT_ENDPOINT = "https://router.slashpeak.com";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export interface Settings {
  /** An API key with the Job Router permission. Without it the SDK does nothing. */
  readonly apiKey: string | null;
  readonly endpoint: string;
  /** The SDK's own ceiling. The stricter of this and the server's mode wins. */
  readonly mode: Mode;
  /** Send query parameter values (masked first). Off if the SDK or the server says off. */
  readonly sendParamValues: boolean;
}

export type SettingsInput = Partial<Settings>;

/** Fills defaults. An unknown mode is a typo: do nothing rather than guess. */
export function makeSettings(input: SettingsInput = {}): Settings {
  const mode = String(input.mode ?? "active").trim().toLowerCase();
  return Object.freeze({
    apiKey: (input.apiKey ?? "").trim() || null,
    endpoint: (input.endpoint ?? DEFAULT_ENDPOINT).trim().replace(/\/+$/, ""),
    mode: (MODES as readonly string[]).includes(mode) ? (mode as Mode) : "off",
    sendParamValues: input.sendParamValues ?? true,
  });
}

/** A key, a mode other than off, and an endpoint the key may be sent to. */
export function isUsable(settings: Settings): boolean {
  return Boolean(settings.apiKey) && settings.mode !== "off" && endpointIsSafe(settings.endpoint);
}

/** HTTPS only. Plain HTTP is allowed for a local test server, never for a remote host. */
export function endpointIsSafe(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol === "https:" && url.hostname) return true;
  return url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname);
}

function flag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  return !["0", "false", "off", "no"].includes(value.trim().toLowerCase());
}

export function loadSettings(env: NodeJS.ProcessEnv = process.env): Settings {
  return makeSettings({
    apiKey: env.SLASHPEAK_API_KEY ?? null,
    endpoint: env.SLASHPEAK_ENDPOINT?.trim() || DEFAULT_ENDPOINT,
    mode: (env.SLASHPEAK_MODE?.trim() || "active") as Mode,
    sendParamValues: flag(env.SLASHPEAK_SEND_PARAM_VALUES, true),
  });
}

export function sameSettings(a: Settings, b: Settings): boolean {
  return a.apiKey === b.apiKey && a.endpoint === b.endpoint && a.mode === b.mode && a.sendParamValues === b.sendParamValues;
}

/** off < shadow < active; an unknown value counts as off. */
export function stricterMode(a: unknown, b: unknown): Mode {
  const rank = (mode: unknown): number => {
    const index = MODES.indexOf(mode as Mode);
    return index < 0 ? 0 : index;
  };
  return MODES[Math.min(rank(a), rank(b))]!;
}
