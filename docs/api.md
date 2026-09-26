# Periscope API

Section 8.3 of the architecture. Start it with `npm run api` (port 4747, `PERISCOPE_API_PORT` to change). Without `STEEL_API_KEY` every read endpoint works from `data/periscope.sqlite`; the endpoints that need a browser answer `503 {ok:false, reason}`. JSON everywhere, CORS open, `ok` on every body. Example responses for every route are in `fixtures/api/` (regenerate with `npx tsx scripts/api-fixtures.ts`), which is what the frontend builds against.

| Method and path | Purpose | Body or query |
|---|---|---|
| `GET /health` | liveness, schema version, whether Steel is configured | |
| `POST /account-setups` | open a Steel session with a persistent profile, return `viewerUrl` for the human to log in | `{competitor, url, indicator, account?, country?}` |
| `POST /account-setups/:id/finish` | after the human logged in: verify the indicator, settle, release, save the profile, wait for READY in the background | |
| `GET /accounts/:id/status` | setup id, profile id, or `competitor/account` | |
| `POST /runs` | launch a run; `Idempotency-Key` header replays the same run id for the same body, 409 for a different body | `{competitor, url, pages?, jobs?, countries?, capUsd?, start?, profileId?, accountRef?, runId?, category?, goal?}` |
| `GET /runs?limit=50` | newest runs first with spend, observation count, competitors, whether still live | |
| `GET /runs/:id/observations` | observations of a run, filtered; `q` matches every word against text, url and revealing label | `q?`, `competitor?`, `layer?`, `missedByFetch?`, `limit?` |
| `GET /runs/:id/map` | whole-site runs (`jobs: ["map"]`, optional `maxPages`): pages found, ranked pages opened, documents seen; `ready` is false until discovery finishes | |
| `GET /runs/:id` | run record with `spentUsd` and `capUsd` in dollars, jobs with states and reasons, counts, counters | |
| `POST /runs/:id/cancel` | cancel queued and active jobs; active sessions receive an abort and are released | |
| `GET /runs/:id/events` | Server-sent events with ordered `id:` lines; reconnect with `Last-Event-ID`; ends with `event: end` once the run is terminal. `?format=json&after=N` returns the same as JSON | |
| `GET /sessions`, `GET /runs/:id/sessions` | live Steel sessions right now: `playerUrl` (embeddable WebRTC live view, no auth), `viewerUrl`, purpose, vantage, current page url, run and competitor, `pendingWall` | |
| `GET /handoffs` | pending walls waiting for a human | |
| `POST /jobs/:id/takeover` | the live view url and the generation to resume with | |
| `POST /jobs/:id/resume` | forwarded to the Steel segment; 409 with a reason when the generation is stale | `{generation?}` |
| `GET /jobs/:id/viewer` | live view url for a job (pending handoff, else last observation that carried one) | |
| `GET /runs/:id/coverage` | per page: surface, hidden, missed by fetch, documents, vantages, revealing actions; `counter` is the number or `"uncertain"` when the benchmark failed | |
| `GET /runs/:id/borders` | one grid per url: per vantage totals and unique lines, per country price lines and lines no other country saw, `differsByCountry`, `differsByDevice` | |
| `GET /runs/:id/prices` | pricing rows: decimal `amount`, `currency`, `period`, vantage, the observation id behind each | |
| `GET /runs/:id/matrix` | feature findings with status and evidence ids; empty with a note until extraction runs with a model | |
| `GET /matrix?runs=<id>,<id>` | comparison matrix using the newest selected run for each competitor | `runs` required, up to 20 |
| `POST /runs/:id/research` | evidence-backed research answer; semantic retrieval when enabled, keyword fallback otherwise | `{query}` |
| `GET /runs/:id/diff?from=<runId>` | added, removed, unchanged lines and new price lines between two runs of the same competitor | `from` required |
| `GET /findings/:id` | the finding, its resolved observations, artifact paths with `exists`, count of unresolved ids | |
| `GET /artifacts/:id` | streams the file; `?meta=1` for the record only; 410 when the file is gone | |

## Event stream

```
id: 42
event: observation
data: {"eventId":42,"runId":"r1","jobId":"j1","type":"observation","createdAt":"...","event":{"type":"observation","data":{...}}}
```

Event types are the contract's `Event` union: `observation`, `receipt`, `counter`, `handoff`, `job_state`, `spend`, `run_done`. Ids are the SQLite row ids, strictly increasing per run.

## Typical frontend flow

1. `POST /runs` with an idempotency key, keep `runId`.
2. Open `GET /runs/:id/events`; render `counter` events as the red counter, `handoff` events as the human-in-the-loop card with `viewerUrl`.
3. On a handoff, a person opens `viewerUrl`, clears the wall, the page calls `POST /jobs/:id/resume`.
4. When `event: end` arrives, load `/coverage`, `/borders`, `/prices`, `/matrix`, and `/diff?from=<previous run>`.
5. Every row links to `GET /findings/:id` or carries observation ids; the evidence drawer shows them with the artifact when it exists.
