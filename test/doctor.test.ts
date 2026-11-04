import assert from "node:assert/strict";
import { test } from "node:test";
import { reservationName, runDoctor, USE_PERMISSION, type IamSession } from "../src/doctor.js";
import { makeSettings } from "../src/core/settings.js";
import { serve } from "./helpers.js";

const CONFIG = { policies: [{ projects: [], mode: "active", allowedReservations: ["admin:US.etl"] }], minClient: { typescript: "0.0.1" } };

function iam(granted: boolean): () => Promise<IamSession> {
  return async () => ({
    principal: "jobs@p.iam.gserviceaccount.com",
    post: async () => ({ status: 200, body: { permissions: granted ? [USE_PERMISSION] : [] } }),
  });
}

async function doctor(options: { key?: string | null; config?: unknown; status?: number; granted?: boolean }) {
  const server = await serve((_method, path) => {
    if (path === "/v1/health") return [200, { ok: true }];
    return [options.status ?? 200, options.config ?? CONFIG];
  });
  const lines: string[] = [];
  const code = await runDoctor({
    settings: makeSettings({ apiKey: options.key === undefined ? "secret-key" : options.key, endpoint: server.url }),
    out: (line) => lines.push(line),
    iamSessionFactory: iam(options.granted ?? true),
    bigQueryRequest: () => () => undefined,
  });
  await server.close();
  return { code, text: lines.join("\n") };
}

test("all good", async () => {
  const { code, text } = await doctor({});
  assert.equal(code, 0, text);
  assert.match(text, /may use projects\/admin\/locations\/US\/reservations\/etl/);
  assert.match(text, /all checks passed/);
  assert.ok(!text.includes("secret-key"));
});

test("a missing permission prints the fix", async () => {
  const { code, text } = await doctor({ granted: false });
  assert.equal(code, 1);
  assert.match(text, /roles\/bigquery\.user/);
});

test("a bad key, and no key", async () => {
  const bad = await doctor({ status: 401, config: { error: { code: "unauthorized", message: "x" } } });
  assert.equal(bad.code, 1);
  assert.match(bad.text, /key refused \(HTTP 401, unauthorized\)/);
  const none = await doctor({ key: null });
  assert.equal(none.code, 1);
  assert.match(none.text, /SLASHPEAK_API_KEY is not set/);
});

test("active mode without a reservation", async () => {
  const { code, text } = await doctor({ config: { policies: [{ projects: [], mode: "active" }] } });
  assert.equal(code, 1);
  assert.match(text, /active mode with no allowed reservation/);
});

test("reservation names", () => {
  assert.equal(reservationName("admin:US.etl"), "projects/admin/locations/US/reservations/etl");
  assert.equal(reservationName("my-proj:europe-west1.batch"), "projects/my-proj/locations/europe-west1/reservations/batch");
  assert.equal(reservationName("nope"), null);
});
