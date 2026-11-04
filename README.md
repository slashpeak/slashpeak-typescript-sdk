# slashpeak

SlashPeak Job Router for Node.js and TypeScript. Before each warehouse job starts, the SDK asks the router where
the job costs less. For BigQuery that means on-demand, or a reservation you allowed. The router answers from your
own job history. If the answer is "move", the SDK sets the job's `reservation` field. Your SQL, project, location,
destination, priority and cache settings never change.

Docs: https://slashpeak.com/docs/product/job-router

Supported today: BigQuery ([@google-cloud/bigquery](https://www.npmjs.com/package/@google-cloud/bigquery) 7.x to 9.x).
More warehouses will come as add-ons to this same package, sharing one key and one connection pool.

Needs Node.js 20.19 or newer. The package is ESM; `require("slashpeak")` works too (Node 20.19+ loads ESM from `require`).

## Install

```bash
npm install slashpeak
```

```ts
import * as slashpeak from "slashpeak";

slashpeak.install(); // hooks every supported library that is installed
```

Call it once at startup, before your first query. Or BigQuery only, or one client only:

```ts
import { BigQuery } from "@google-cloud/bigquery";
import * as slashpeakBigQuery from "slashpeak/bigquery";

slashpeakBigQuery.install();                              // every BigQuery client
const bigquery = slashpeakBigQuery.wrap(new BigQuery());  // or just this one
```

Settings can also be passed in code. What you leave out comes from the environment:

```ts
slashpeak.install({ apiKey: process.env.MY_SECRET, mode: "shadow" });
```

Then check your setup:

```bash
npx slashpeak doctor            # key, network path, reservation access
npx slashpeak doctor --latency  # also 20 warm round trips
```

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `SLASHPEAK_API_KEY` | none | An API key with the **Job Router** permission (SlashPeak → Settings → API keys). Without it the SDK does nothing. |
| `SLASHPEAK_MODE` | `active` | `off`, `shadow` or `active`. The stricter of this and the Job Router page wins. |
| `SLASHPEAK_ENDPOINT` | `https://router.slashpeak.com` | HTTPS only. |
| `SLASHPEAK_SEND_PARAM_VALUES` | on | Send query parameter values (masked first). Off if this or the Job Router page says off. |
| `HTTPS_PROXY`, `NO_PROXY` | | Honored. |

## Safety rules

- **Fail open.** Any error, or no answer within 500 ms (DNS included), and the job runs exactly as you wrote it.
  After 5 failures in a row the SDK stops asking for 30 s.
- **Never fails a job that would have run.** If BigQuery refuses a changed job at insert (a 4xx, for example no
  permission on the reservation), the SDK runs your original request once, with the same job id, and reports
  `fallback`. On the `jobs.query` path (what `query()` uses when it can), BigQuery also returns a 4xx for a query
  that ran and failed, so the SDK re-runs only when the error names the reservation or a label. When the
  reservation was deleted, BigQuery answers `jobs.insert` with a job that failed at once (nothing ran): the SDK runs
  your original request once under a new job id (`<your id>_fb` and 8 characters), and sends the client's later
  calls for that job (polls, results, cancel) to the new id. A failed query is never run twice.
- **PII is masked before anything leaves your process**: emails, phone numbers, IP addresses, and the patterns you
  add in SlashPeak → Settings → Privacy. Backtick-quoted names are left alone. Masking uses RE2 (the same engine
  and rules as the router and as BigQuery), so it runs in linear time.
- **Never touched:** jobs with an explicit `reservation`, dry runs, load, copy, extract and continuous jobs, SQL
  over 256 KB, and SQL with `/* slashpeak:off */`. To skip a block of code:
  `await slashpeakBigQuery.bypass(() => bigquery.query(sql))`.
- **No extra BigQuery calls.** Job results are read from responses the client already fetches.
- **Never logs** SQL, values or keys.

## Connections

- One pooled HTTPS agent per process (undici), HTTP/1.1 keep-alive: a warm call pays no TCP or TLS handshake.
- One hard 500 ms deadline per decide that covers the queue, DNS, connect, TLS and the answer.
- At most 8 sockets. No hidden retries, no redirects, no cookies. TLS is always verified.
- Events are batched every 2 s (at most 100 per call, bounded queue). Timers never keep your process alive.
- At a normal exit, queued events are sent for at most 1 s. Before `process.exit()`, or at the end of a serverless
  handler, call `await slashpeak.flush()`. `await slashpeak.uninstall()` removes the hook and flushes.
- Node does not fork a running process (cluster workers and child processes start fresh), so no socket is ever
  shared between processes.

## Contract

`spec/` holds the router contract this SDK is tested against:

- `openapi.json`: the HTTP API (`GET https://router.slashpeak.com/v1/openapi.json` serves the same file).
- `mask_vectors.json`: the PII masking rules and test vectors.

The SDK never fingerprints queries. The server does that, so a fingerprint change never needs an SDK release.

## Develop

```bash
npm ci
npm test        # type check + node:test (unit, local HTTP servers, the real BigQuery client)
npm run build   # dist/
```

## Security

Report a vulnerability to security@slashpeak.com. Please do not open a public issue for it.

## License

Apache-2.0. See [LICENSE](LICENSE).
