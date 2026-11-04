/**
 * `slashpeak doctor`: checks the key, the network path and reservation access.
 *
 * Prints a fix for each problem. Never prints the key, SQL or values.
 */

import { createRequire } from "node:module";
import { clientAtLeast, SDK_NAME } from "./core/router.js";
import { isRecord } from "./core/mask.js";
import { endpointIsSafe, loadSettings, type Settings } from "./core/settings.js";
import { Transport } from "./core/transport.js";
import { VERSION } from "./version.js";

export const RESERVATION_API = "https://bigqueryreservation.googleapis.com/v1";
export const USE_PERMISSION = "bigquery.reservations.use";
export const LATENCY_BUDGET_MS = 320;
const REF = /^(.+):([^:.]+)\.([^.]+)$/;
const require = createRequire(import.meta.url);

export type Out = (line: string) => void;

/** One permission check: POST `{name}:testIamPermissions` with the caller's Google credentials. */
export interface IamSession {
  principal: string;
  post(url: string, body: unknown): Promise<{ status: number; body: unknown }>;
}

class Report {
  problems = 0;
  constructor(private readonly out: Out) {}
  ok(text: string): void {
    this.out(`  ok    ${text}`);
  }
  bad(text: string, fix: string): void {
    this.problems += 1;
    this.out(`  FAIL  ${text}`);
    this.out(`        fix: ${fix}`);
  }
  note(text: string): void {
    this.out(`  note  ${text}`);
  }
}

/** `project:location.name` → `projects/{p}/locations/{l}/reservations/{r}`. */
export function reservationName(ref: string): string | null {
  const match = REF.exec(ref.trim());
  return match ? `projects/${match[1]}/locations/${match[2]}/reservations/${match[3]}` : null;
}

async function timed<T>(call: () => Promise<T>): Promise<[T, number]> {
  const started = performance.now();
  const result = await call();
  return [result, performance.now() - started];
}

/** Loads `google-auth-library` (a dependency of `@google-cloud/bigquery`) from wherever it is installed. */
function loadGoogleAuth(): { GoogleAuth: new (options: unknown) => GoogleAuthLike } {
  try {
    return require("google-auth-library");
  } catch {
    const fromBigQuery = createRequire(require.resolve("@google-cloud/bigquery"));
    return fromBigQuery("google-auth-library");
  }
}

interface GoogleAuthLike {
  getClient(): Promise<{ request(options: unknown): Promise<{ status: number; data: unknown }> }>;
  getCredentials(): Promise<{ client_email?: string }>;
}

async function defaultIamSession(): Promise<IamSession> {
  const { GoogleAuth } = loadGoogleAuth();
  const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  const client = await auth.getClient();
  const credentials = await auth.getCredentials().catch(() => ({}) as { client_email?: string });
  return {
    principal: credentials.client_email || "the identity your jobs run as",
    async post(url, body) {
      const response = await client.request({ url, method: "POST", data: body, timeout: 10_000, validateStatus: () => true });
      return { status: response.status, body: response.data };
    },
  };
}

async function iamCheck(names: string[], report: Report, sessionFactory?: () => Promise<IamSession>): Promise<void> {
  let session: IamSession;
  try {
    session = await (sessionFactory ?? defaultIamSession)();
  } catch (error) {
    report.bad(
      `Google credentials not found (${error instanceof Error ? error.name : "error"})`,
      "run this where your jobs run, or run `gcloud auth application-default login`"
    );
    return;
  }
  for (const name of names) {
    let status: number | string = "no answer";
    let granted = false;
    try {
      const response = await session.post(`${RESERVATION_API}/${name}:testIamPermissions`, { permissions: [USE_PERMISSION] });
      status = response.status;
      const permissions = isRecord(response.body) ? response.body.permissions : null;
      granted = response.status === 200 && Array.isArray(permissions) && permissions.includes(USE_PERMISSION);
    } catch {
      granted = false;
    }
    if (granted) {
      report.ok(`${session.principal} may use ${name}`);
    } else {
      report.bad(
        `${session.principal} may not use ${name} (HTTP ${status})`,
        `grant roles/bigquery.user to ${session.principal} on the reservation itself ` +
          "(BigQuery > Capacity management > Reservations > the reservation > Permissions). " +
          "roles/bigquery.jobUser does not include bigquery.reservations.use."
      );
    }
  }
}

export interface DoctorOptions {
  settings?: Settings;
  latency?: boolean;
  out?: Out;
  transport?: Transport;
  iamSessionFactory?: () => Promise<IamSession>;
  /** Tests: pretend the BigQuery library is (or is not) installed. */
  bigQueryRequest?: () => unknown;
}

function findHookPoint(): unknown {
  const { BigQuery } = require("@google-cloud/bigquery") as { BigQuery: { prototype: { request?: unknown } } };
  return BigQuery.prototype.request;
}

/** Exit code: 0 when every check passed, 1 otherwise. */
export async function runDoctor(options: DoctorOptions = {}): Promise<number> {
  const settings = options.settings ?? loadSettings();
  const out = options.out ?? ((line: string) => console.log(line));
  const report = new Report(out);
  out(`slashpeak ${VERSION} (node ${process.versions.node})`);

  let hookPoint: unknown;
  try {
    hookPoint = (options.bigQueryRequest ?? findHookPoint)();
    if (typeof hookPoint === "function") report.ok("@google-cloud/bigquery installed; hook point found");
    else report.bad("@google-cloud/bigquery has no BigQuery.prototype.request", "upgrade @google-cloud/bigquery to 7.x or newer");
  } catch {
    report.bad("no supported warehouse library installed", "npm install @google-cloud/bigquery");
  }

  if (!settings.apiKey) {
    report.bad(
      "SLASHPEAK_API_KEY is not set",
      "make an API key with the Job Router permission (Settings → API keys) and set SLASHPEAK_API_KEY"
    );
    return 1;
  }
  report.ok("SLASHPEAK_API_KEY is set");
  if (!endpointIsSafe(settings.endpoint)) {
    report.bad("SLASHPEAK_ENDPOINT is not HTTPS", "use https://router.slashpeak.com");
    return 1;
  }
  if (settings.mode === "off") report.note("SLASHPEAK_MODE=off: the SDK will not call the router");

  const transport = options.transport ?? new Transport(settings.endpoint, settings.apiKey);
  try {
    try {
      const [health, ms] = await timed(() => transport.request("GET", "/v1/health"));
      if (health.status === 200) report.ok(`router reachable (${ms.toFixed(0)} ms, first call includes TLS)`);
      else report.bad(`router answered HTTP ${health.status}`, "check proxies and firewalls for router.slashpeak.com");
    } catch (error) {
      report.bad(
        `router not reachable (${error instanceof Error ? error.name : "error"})`,
        "allow HTTPS egress to router.slashpeak.com; set HTTPS_PROXY if you use one"
      );
      return 1;
    }

    const configReply = await transport.request("GET", "/v1/config");
    if (configReply.status !== 200 || configReply.body === null) {
      const error = configReply.body?.error;
      const code = isRecord(error) && typeof error.code === "string" ? `, ${error.code}` : "";
      report.bad(`key refused (HTTP ${configReply.status}${code})`, "use an API key with the Job Router permission (Settings → API keys)");
      return 1;
    }
    const config = configReply.body;
    report.ok("key accepted");
    if (config.killSwitch) report.note("the router is paused for everyone right now (jobs run unchanged)");
    const minimum = isRecord(config.minClient) ? config.minClient[SDK_NAME] : undefined;
    if (!clientAtLeast(VERSION, minimum)) report.bad(`this SDK is older than the minimum ${String(minimum)}`, "npm install slashpeak@latest");
    const policies = Array.isArray(config.policies) ? config.policies.filter(isRecord) : [];
    if (policies.length === 0) report.note("no router settings yet: open the Job Router page and pick shadow or active");
    for (const policy of policies) {
      const projects = Array.isArray(policy.projects) ? policy.projects : [];
      report.note(`mode ${String(policy.mode)} for ${projects.length ? projects.join(", ") : "all projects of the connection"}`);
    }

    const refs = [
      ...new Set(policies.flatMap((p) => (Array.isArray(p.allowedReservations) ? p.allowedReservations : [])).filter((r): r is string => typeof r === "string")),
    ].sort();
    const names = refs.map(reservationName).filter((name): name is string => name !== null);
    if (names.length > 0) await iamCheck(names, report, options.iamSessionFactory);
    else if (policies.some((p) => p.mode === "active")) report.bad("active mode with no allowed reservation", "pick a reservation on the Job Router page");

    if (options.latency) {
      const samples: number[] = [];
      for (let i = 0; i < 20; i++) {
        try {
          samples.push((await timed(() => transport.request("GET", "/v1/health")))[1]);
        } catch {
          // Counted as missing.
        }
      }
      if (samples.length < 2) {
        report.bad("latency check failed (no answers)", "check the network path to router.slashpeak.com");
      } else {
        samples.sort((a, b) => a - b);
        const p50 = samples[Math.floor(samples.length / 2)]!;
        const p95 = samples[Math.min(samples.length - 1, Math.round(0.95 * (samples.length - 1)))]!;
        const text = `warm round trip p50 ${p50.toFixed(0)} ms, p95 ${p95.toFixed(0)} ms (${samples.length} calls)`;
        if (p95 > LATENCY_BUDGET_MS) report.bad(text, "run jobs closer to us-central1, or keep the router in shadow mode");
        else report.ok(text);
      }
    }
  } finally {
    await transport.close();
  }

  out(report.problems === 0 ? "all checks passed" : `${report.problems} problem(s) found`);
  return report.problems === 0 ? 0 : 1;
}
