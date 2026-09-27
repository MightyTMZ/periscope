// Periscope API, section 8.3 of the architecture. Dependency-free node:http over Ayaan's Storage and Fahad's segment.
// Every read endpoint works from SQLite alone (A14: no Steel or Claude key needed); the write endpoints that need
// Steel answer 503 with the documented shape when no segment is configured. Contract and examples: docs/api.md.
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import http from "node:http";
import type { Storage } from "@periscope/knowledge";
import type { HandoffEvent, LeaseRequest, SessionHandle } from "@periscope/contracts";
import { bordersGrid } from "../intel/borders-grid.js";
import { coverage } from "../intel/coverage.js";
import { diffRuns } from "../intel/diff.js";
import { priceRows } from "../intel/prices.js";
import { extractFeatures, summarizeDiff, type Complete } from "../intel/extract.js";
import { loadProfiles, profileFor, saveProfile, waitUntilReady } from "../steel/profiles.js";
import type { LaunchHandle, RunSpec } from "../integration/launch-run.js";
import type { LiveSessionView } from "../integration/live-sessions.js";
import { comparisonMatrix } from "../intel/matrix.js";
import { meteredCompletion } from "../intel/metered-completion.js";
import { ArtifactStore } from "@periscope/knowledge";
import { evidenceRoot } from "../integration/evidence.js";
import type { Corpus } from "@periscope/knowledge";
import { research } from "../intel/research.js";

/** What the API needs from the Steel segment. Narrow so tests can fake it. */
export interface ApiSegment {
  resume: (jobId: string, generation: number) => Promise<{ ok: boolean; reason?: string }>;
  acquireSession?: (req: LeaseRequest) => Promise<SessionHandle>;
  profileStatus?: (profileId: string) => Promise<string>;
}

export interface ApiOptions {
  storage: Storage;
  corpus?: Corpus;
  segment?: ApiSegment;
  launch?: (spec: RunSpec) => LaunchHandle;
  port?: number;                 // default PERISCOPE_API_PORT or 4747; 0 picks a free port
  settleMs?: number;             // profile settle before release on finish; default 40 s
  complete?: Complete;           // model behind /extract and diff summaries; absent means 503 / no summary
  liveSessions?: (runId?: string) => LiveSessionView[]; // live Steel sessions with their owners, for the live view
}

export interface Api {
  port: number;
  server: http.Server;
  close: () => Promise<void>;
  recordHandoff: (h: HandoffEvent) => void;
  pendingHandoffs: () => HandoffEvent[];
}

interface AccountSetup {
  id: string; competitor: string; accountRef: string; url: string; indicator: string; country: string;
  state: "awaiting_login" | "finishing" | "ready" | "failed"; viewerUrl?: string; profileId?: string; reason?: string; createdAt: string;
  handle?: SessionHandle;
}

type Ctx = { req: http.IncomingMessage; res: http.ServerResponse; url: URL; params: Record<string, string> };
type Handler = (c: Ctx) => Promise<void> | void;

export function createApi(opts: ApiOptions): Promise<Api> {
  const { storage } = opts;
  const artifacts = new ArtifactStore({ storage, root: evidenceRoot() });
  const runs = new Map<string, LaunchHandle>();
  const pending = new Map<string, HandoffEvent>();
  const setups = new Map<string, AccountSetup>();
  const routes: Array<[string, RegExp, string[], Handler]> = [];
  const route = (method: string, pattern: string, h: Handler) => {
    const names: string[] = [];
    const re = new RegExp("^" + pattern.replace(/:([a-zA-Z]+)/g, (_, n) => { names.push(n); return "([^/]+)"; }) + "$");
    routes.push([method, re, names, h]);
  };
  const json = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" });
    res.end(JSON.stringify(body));
  };
  const readBody = (req: http.IncomingMessage) => new Promise<Record<string, unknown>>((resolve, reject) => {
    let raw = ""; req.on("data", (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on("end", () => { try { resolve(raw ? (JSON.parse(raw) as Record<string, unknown>) : {}); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
  const runOr404 = (c: Ctx) => { const r = storage.getRun(c.params.id); if (!r) json(c.res, 404, { ok: false, reason: `run ${c.params.id} not found` }); return r; };
  const dollars = (micro: number) => Number((micro / 1e6).toFixed(6));

  /* ---------------- health and accounts ---------------- */
  route("GET", "/health", (c) => json(c.res, 200, { ok: true, schemaVersion: storage.schemaVersion(), steel: Boolean(opts.segment?.acquireSession), model: Boolean(opts.complete) }));

  route("POST", "/account-setups", async (c) => {
    const b = await readBody(c.req);
    const competitor = String(b.competitor ?? ""), url = String(b.url ?? ""), indicator = String(b.indicator ?? "");
    if (!competitor || !url || !indicator) return json(c.res, 400, { ok: false, reason: "competitor, url and indicator are required" });
    const setup: AccountSetup = { id: randomUUID(), competitor, url, indicator, accountRef: String(b.account ?? "trial1"), country: String(b.country ?? "CA"), state: "awaiting_login", createdAt: new Date().toISOString() };
    if (!opts.segment?.acquireSession) return json(c.res, 503, { ok: false, reason: "steel not configured; run setup-account from the CLI", setup: publicSetup(setup) });
    try {
      const handle = await opts.segment.acquireSession({ vantage: { country: setup.country, device: "desktop", authenticated: true }, purpose: "setup", accountRef: setup.accountRef });
      setup.handle = handle; setup.viewerUrl = handle.viewerUrl; setup.profileId = handle.profileId;
      await handle.page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => undefined);
      setups.set(setup.id, setup);
      json(c.res, 201, { ok: true, setup: publicSetup(setup), instructions: "open viewerUrl, log in by hand, then POST /account-setups/:id/finish" });
    } catch (e) { setup.state = "failed"; setup.reason = (e as Error).message; setups.set(setup.id, setup); json(c.res, 502, { ok: false, reason: setup.reason, setup: publicSetup(setup) }); }
  });

  route("POST", "/account-setups/:id/finish", async (c) => {
    const s = setups.get(c.params.id);
    if (!s) return json(c.res, 404, { ok: false, reason: "setup not found" });
    if (!s.handle || s.state !== "awaiting_login") return json(c.res, 409, { ok: false, reason: `setup is ${s.state}`, setup: publicSetup(s) });
    const text = await s.handle.page.locator("body").innerText().catch(() => "");
    if (!text.includes(s.indicator)) return json(c.res, 409, { ok: false, reason: `signed-in indicator "${s.indicator}" not visible yet`, setup: publicSetup(s) });
    s.state = "finishing";
    json(c.res, 202, { ok: true, setup: publicSetup(s) });
    const handle = s.handle; s.handle = undefined;
    void (async () => {
      try {
        await handle.page.waitForTimeout(opts.settleMs ?? 40_000);
        await handle.release();
        const rec = { profileId: s.profileId ?? "", competitor: s.competitor, accountRef: s.accountRef, homeCountry: s.country, signedInIndicator: s.indicator, createdAt: s.createdAt, ready: false };
        saveProfile(rec);
        if (opts.segment?.profileStatus && s.profileId) await waitUntilReady(s.profileId, async (id) => (await opts.segment!.profileStatus!(id)) === "READY", 120_000);
        saveProfile({ ...rec, ready: true }); s.state = "ready";
      } catch (e) { s.state = "failed"; s.reason = (e as Error).message; }
    })();
  });

  route("GET", "/accounts/:id/status", async (c) => {
    // id is a setup id, a profile id, or competitor/accountRef
    const s = setups.get(c.params.id);
    if (s) return json(c.res, 200, { ok: true, setup: publicSetup(s) });
    const [competitor, accountRef] = decodeURIComponent(c.params.id).split("/");
    const p = loadProfiles().find((x) => x.profileId === c.params.id) ?? (accountRef ? profileFor(competitor, accountRef) : undefined);
    if (!p) return json(c.res, 404, { ok: false, reason: "no setup or profile with that id" });
    let steelStatus: string | null = null;
    if (opts.segment?.profileStatus) steelStatus = await opts.segment.profileStatus(p.profileId).catch(() => null);
    json(c.res, 200, { ok: true, profile: { profileId: p.profileId, competitor: p.competitor, accountRef: p.accountRef, homeCountry: p.homeCountry, ready: p.ready, steelStatus, credential: Boolean(p.credentialNamespace) } });
  });

  /* ---------------- runs ---------------- */
  route("POST", "/runs", async (c) => {
    const b = await readBody(c.req);
    const key = (c.req.headers["idempotency-key"] as string | undefined) ?? (b.idempotencyKey as string | undefined);
    const hash = createHash("sha256").update(JSON.stringify({ ...b, idempotencyKey: undefined })).digest("hex");
    if (key) {
      const prior = storage.getRunIdempotency(key);
      if (prior && prior.requestHash !== hash) return json(c.res, 409, { ok: false, reason: "idempotency key reused with a different body" });
      if (prior) return json(c.res, 200, { ok: true, runId: prior.runId, replayed: true, run: runView(storage, prior.runId, runs) });
    }
    if (!b.competitor || !b.url) return json(c.res, 400, { ok: false, reason: "competitor and url are required" });
    const spec: RunSpec = {
      runId: String(b.runId ?? `run-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`), competitor: String(b.competitor), url: String(b.url),
      pages: b.pages as string[] | undefined, jobs: b.jobs as RunSpec["jobs"], countries: b.countries as string[] | undefined,
      maxPages: b.maxPages === undefined ? undefined : Math.max(1, Math.min(1000, Number(b.maxPages))),
      capUsd: b.capUsd === undefined ? undefined : Number(b.capUsd), start: b.start as string | undefined, profileId: b.profileId as string | undefined,
      accountRef: b.accountRef as string | undefined, category: b.category as string | undefined, goal: b.goal as string | undefined,
    };
    if (storage.getRun(spec.runId)) return json(c.res, 409, { ok: false, reason: `run ${spec.runId} exists` });
    if (!opts.launch) return json(c.res, 503, { ok: false, reason: "steel not configured; this API is read-only", spec });
    storage.createRun({ id: spec.runId, goal: spec.goal, category: spec.category ?? "demo", capUsd: spec.capUsd ?? 12, status: "running" });
    if (key) storage.recordRunIdempotency(key, spec.runId, hash);
    let handle: LaunchHandle;
    try { handle = opts.launch(spec); } catch (e) { storage.setRunStatus(spec.runId, "failed", (e as Error).message); return json(c.res, 400, { ok: false, reason: (e as Error).message }); }
    runs.set(spec.runId, handle);
    handle.done.then(() => runs.delete(spec.runId), (e: Error) => { storage.setRunStatus(spec.runId, "failed", e.message); runs.delete(spec.runId); });
    json(c.res, 202, { ok: true, runId: spec.runId, run: runView(storage, spec.runId, runs) });
  });

  route("GET", "/runs", (c) => {
    const limit = Math.min(Number(c.url.searchParams.get("limit") ?? 50), 500);
    json(c.res, 200, { ok: true, runs: storage.listRuns(limit).map((r) => ({ ...r, spentUsd: dollars(r.spentMicroUsd), capUsd: dollars(r.capMicroUsd), live: runs.has(r.id), observations: storage.countObservations(r.id), competitors: [...new Set(storage.getJobsByRun(r.id).map((j) => j.competitor).filter(Boolean))], purposes: [...new Set(storage.getJobsByRun(r.id).map((j) => j.purpose))] })) });
  });
  route("GET", "/runs/:id", (c) => { if (runOr404(c)) json(c.res, 200, { ok: true, ...runView(storage, c.params.id, runs) }); });
  route("GET", "/runs/:id/observations", (c) => {
    if (!runOr404(c)) return;
    const q = (c.url.searchParams.get("q") ?? "").toLowerCase();
    const competitor = c.url.searchParams.get("competitor") ?? undefined;
    const layer = (c.url.searchParams.get("layer") ?? undefined) as "surface" | "hidden" | "borders" | "interior" | undefined;
    const missed = c.url.searchParams.get("missedByFetch");
    const limit = Math.min(Number(c.url.searchParams.get("limit") ?? 200), 2000);
    const all = storage.getObservationsByRun(c.params.id, { competitor, layer, missedByFetch: missed === null ? undefined : missed === "1" || missed === "true" });
    const words = q.split(/\s+/).filter(Boolean);
    const hits = words.length ? all.filter((o) => { const hay = `${o.text} ${o.url} ${o.revealedBy?.label ?? ""}`.toLowerCase(); return words.every((w) => hay.includes(w)); }) : all;
    json(c.res, 200, { ok: true, runId: c.params.id, total: hits.length, observations: hits.slice(0, limit) });
  });

  route("POST", "/runs/:id/cancel", async (c) => {
    if (!runOr404(c)) return;
    const h = runs.get(c.params.id);
    if (h) await h.cancel(); else storage.setRunStatus(c.params.id, "cancelled", "cancelled through the API");
    json(c.res, 200, { ok: true, ...runView(storage, c.params.id, runs) });
  });

  route("GET", "/runs/:id/events", (c) => {
    if (!runOr404(c)) return;
    const after = Number(c.req.headers["last-event-id"] ?? c.url.searchParams.get("after") ?? 0);
    if (c.url.searchParams.get("format") === "json") return json(c.res, 200, { ok: true, events: storage.readEventsAfter(c.params.id, after, 500) });
    c.res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "access-control-allow-origin": "*" });
    let last = after;
    const tick = () => {
      let batch = storage.readEventsAfter(c.params.id, last, 200);
      for (const e of batch) { c.res.write(`id: ${e.eventId}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`); last = e.eventId; }
      const run = storage.getRun(c.params.id);
      const terminal = run && ["completed", "failed", "cancelled", "partial"].includes(run.status) && !runs.has(c.params.id);
      if (terminal && batch.length < 200) { c.res.write("event: end\ndata: {}\n\n"); c.res.end(); return; }
      timer = setTimeout(tick, 500);
    };
    let timer = setTimeout(tick, 0);
    c.req.on("close", () => clearTimeout(timer));
  });

  /* ---------------- live sessions ---------------- */
  const sessionsView = (runId?: string) => (opts.liveSessions?.(runId) ?? []).map((s) => ({ ...s, pendingWall: [...pending.values()].find((h) => h.viewerUrl === s.viewerUrl)?.wall ?? null }));
  // Whole-site runs: the discovered map (pages found, ranked pages opened, documents), empty until discovery finishes.
  route("GET", "/runs/:id/map", (c) => {
    if (!runOr404(c)) return;
    const site = runs.get(c.params.id)?.map;
    json(c.res, 200, { ok: true, runId: c.params.id, ready: Boolean(site), nodes: site?.nodes ?? 0, edges: site?.edges ?? 0, fetched: site?.fetched ?? 0, sitemap: site?.sitemap ?? false, pages: site?.pages ?? [], documents: site?.documents ?? [] });
  });
  route("GET", "/sessions", (c) => json(c.res, 200, { ok: true, sessions: sessionsView(), steel: Boolean(opts.liveSessions) }));
  route("GET", "/runs/:id/sessions", (c) => { if (runOr404(c)) json(c.res, 200, { ok: true, runId: c.params.id, sessions: sessionsView(c.params.id) }); });

  /* ---------------- human in the loop ---------------- */
  route("GET", "/handoffs", (c) => json(c.res, 200, { ok: true, handoffs: [...pending.values()] }));
  route("POST", "/jobs/:id/takeover", (c) => {
    const h = pending.get(c.params.id);
    if (!h) return json(c.res, 404, { ok: false, reason: "no pending handoff for that job" });
    json(c.res, 200, { ok: true, jobId: h.jobId, wall: h.wall, generation: h.generation, viewerUrl: h.viewerUrl, then: `POST /jobs/${h.jobId}/resume with {"generation": ${h.generation}}` });
  });
  route("POST", "/jobs/:id/resume", async (c) => {
    if (!opts.segment) return json(c.res, 503, { ok: false, reason: "steel not configured" });
    const b = await readBody(c.req).catch(() => ({} as Record<string, unknown>));
    const generation = Number(b.generation ?? pending.get(c.params.id)?.generation ?? 0);
    const r = await opts.segment.resume(c.params.id, generation);
    if (r.ok) pending.delete(c.params.id);
    json(c.res, r.ok ? 200 : 409, r);
  });
  route("GET", "/jobs/:id/viewer", (c) => {
    const job = storage.getJob(c.params.id);
    if (!job) return json(c.res, 404, { ok: false, reason: "job not found" });
    const h = pending.get(job.id);
    const obs = storage.getObservationsByRun(job.runId).filter((o) => o.jobId === job.id && o.viewerUrl).at(-1);
    const viewerUrl = h?.viewerUrl ?? obs?.viewerUrl ?? null;
    json(c.res, viewerUrl ? 200 : 404, { ok: Boolean(viewerUrl), jobId: job.id, state: job.state, viewerUrl, steelSessionId: obs?.steelSessionId ?? null, pendingWall: h?.wall ?? null });
  });

  /* ---------------- intelligence ---------------- */
  route("POST", "/runs/:id/research", async (c) => {
    if (!runOr404(c)) return;
    const body = await readBody(c.req);
    if (typeof body.query !== "string" || !body.query.trim() || body.query.length > 2000) return json(c.res, 400, { ok: false, reason: "query must contain 1 to 2000 characters" });
    json(c.res, 200, { ok: true, ...await research(storage, c.params.id, body.query.trim(), opts.corpus, opts.complete) });
  });
  route("GET", "/matrix", (c) => {
    const ids = (c.url.searchParams.get("runs") ?? "").split(",").filter(Boolean);
    if (!ids.length || ids.length > 20) return json(c.res, 400, { ok: false, reason: "Select 1 to 20 run ids with ?runs=id1,id2" });
    if (ids.some((id) => !storage.getRun(id))) return json(c.res, 404, { ok: false, reason: "Selected run not found" });
    json(c.res, 200, { ok: true, ...comparisonMatrix(storage, ids) });
  });
  route("GET", "/runs/:id/coverage", (c) => {
    if (!runOr404(c)) return;
    const obs = storage.getObservationsByRun(c.params.id);
    const uncertain = new Set(storage.readEventsAfter(c.params.id, 0, 5000).filter((e) => e.type === "counter" && (e.event.data as { missed: unknown }).missed === "uncertain").map((e) => (e.event.data as { url: string }).url));
    const cov = coverage(c.params.id, obs);
    json(c.res, 200, { ok: true, ...cov, pages: cov.pages.map((p) => ({ ...p, counter: uncertain.has(p.url) ? "uncertain" : p.missedByFetch })) });
  });
  route("GET", "/runs/:id/borders", (c) => {
    if (!runOr404(c)) return;
    const obs = storage.getObservationsByRun(c.params.id, { layer: "borders" });
    const urls = [...new Set(obs.map((o) => o.url))];
    json(c.res, 200, { ok: true, runId: c.params.id, grids: urls.map((u) => bordersGrid(u, obs)) });
  });
  route("GET", "/runs/:id/prices", (c) => { if (runOr404(c)) json(c.res, 200, { ok: true, runId: c.params.id, rows: priceRows(storage.getObservationsByRun(c.params.id)) }); });
  const matrixView = (runId: string) => {
    const findings = storage.getFindingsByRun(runId, "feature");
    const competitors = [...new Set(findings.map((f) => f.competitor))].sort();
    const features = [...new Set(findings.map((f) => f.title ?? ""))].sort();
    const cell = (feature: string, competitor: string) => { const f = findings.find((x) => x.title === feature && x.competitor === competitor); return f ? { id: f.id, status: f.status, value: f.value, evidence: f.observationIds } : null; };
    return {
      rows: findings.map((f) => ({ id: f.id, competitor: f.competitor, feature: f.title, status: f.status, value: f.value, evidence: f.observationIds })),
      grid: { competitors, features, cells: features.map((feature) => ({ feature, byCompetitor: Object.fromEntries(competitors.map((co) => [co, cell(feature, co)])) })) },
      note: findings.length ? undefined : opts.complete ? "no feature findings yet; POST /runs/:id/extract" : "no feature findings yet; extraction needs a model key",
    };
  };
  route("GET", "/runs/:id/matrix", (c) => { if (runOr404(c)) json(c.res, 200, { ok: true, runId: c.params.id, ...matrixView(c.params.id) }); });
  route("POST", "/runs/:id/extract", async (c) => {
    if (!runOr404(c)) return;
    if (!opts.complete) return json(c.res, 503, { ok: false, reason: "no model key configured; set ANTHROPIC_API_KEY" });
    const b = await readBody(c.req).catch(() => ({} as Record<string, unknown>));
    const competitors = b.competitor ? [String(b.competitor)] : [...new Set(storage.getJobsByRun(c.params.id).map((j) => j.competitor).filter((x): x is string => Boolean(x)))];
    const results = [];
    for (const competitor of competitors) {
      const r = await extractFeatures({ storage, runId: c.params.id, competitor, complete: meteredCompletion(storage, c.params.id, opts.complete), category: b.category as string | undefined });
      results.push({ competitor, rows: r.rows.length, rejected: r.rejected, findings: r.findings.length, tokensIn: r.tokensIn, tokensOut: r.tokensOut });
    }
    json(c.res, 200, { ok: true, runId: c.params.id, extracted: results, ...matrixView(c.params.id) });
  });
  route("GET", "/runs/:id/diff", async (c) => {
    if (!runOr404(c)) return;
    const from = c.url.searchParams.get("from");
    if (!from) return json(c.res, 400, { ok: false, reason: "query ?from=<earlier runId> is required" });
    if (!storage.getRun(from)) return json(c.res, 404, { ok: false, reason: `run ${from} not found` });
    const diff = diffRuns(from, storage.getObservationsByRun(from), c.params.id, storage.getObservationsByRun(c.params.id));
    const wantSummary = c.url.searchParams.get("summary") === "1";
    const summary = wantSummary && opts.complete ? (await summarizeDiff(diff, meteredCompletion(storage, c.params.id, opts.complete))).bullets : wantSummary ? ["no model key configured; set ANTHROPIC_API_KEY for a written summary"] : undefined;
    json(c.res, 200, { ok: true, ...diff, summary });
  });

  /* ---------------- evidence ---------------- */
  route("GET", "/findings/:id", async (c) => {
    const f = storage.getFinding(c.params.id);
    if (!f) return json(c.res, 404, { ok: false, reason: "finding not found" });
    const observations = f.observationIds.map((id) => storage.getObservation(id)).filter((o): o is NonNullable<typeof o> => Boolean(o));
    const linked = observations.flatMap((o) => storage.artifactsForObservation(o.id).map((a) => ({ ...a, observationId: o.id })));
    const legacy = observations.filter((o) => o.screenshotPath).map((o) => ({ observationId: o.id, path: o.screenshotPath!, exists: existsSync(o.screenshotPath!) }));
    const evidence = [...legacy, ...await Promise.all(linked.map(async (a) => ({ ...a, url: `/artifacts/${a.id}`, exists: await artifacts.resolve(a.id).then(() => true, () => false) })))]
      .filter((a, i, all) => all.findIndex((x) => x.observationId === a.observationId && (x as { id?: string }).id === (a as { id?: string }).id) === i);
    json(c.res, 200, { ok: true, finding: f, observations, artifacts: evidence, unresolved: f.observationIds.length - observations.length });
  });
  route("GET", "/artifacts/:id", async (c) => {
    const a = storage.getArtifact(c.params.id);
    if (!a) return json(c.res, 404, { ok: false, reason: "artifact not found" });
    const file = await artifacts.resolve(a.id).catch(() => null);
    if (c.url.searchParams.get("meta") === "1" || !file) return json(c.res, file ? 200 : 410, { ok: Boolean(file), artifact: a });
    c.res.writeHead(200, { "content-type": a.mediaType ?? "application/octet-stream", "content-length": a.bytes });
    createReadStream(file).pipe(c.res);
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "OPTIONS") { res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "content-type,idempotency-key,last-event-id", "access-control-allow-private-network": "true" }); return res.end(); }
    for (const [method, re, names, h] of routes) {
      const m = url.pathname.match(re);
      if (!m || method !== req.method) continue;
      const params: Record<string, string> = {}; names.forEach((n, i) => { params[n] = m[i + 1]; });
      try { await h({ req, res, url, params }); } catch (e) { if (!res.headersSent) json(res, 500, { ok: false, reason: (e as Error).message }); else res.end(); }
      return;
    }
    json(res, 404, { ok: false, reason: `no route ${req.method} ${url.pathname}` });
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(opts.port ?? Number(process.env.PERISCOPE_API_PORT ?? 4747), () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : Number(opts.port);
      resolve({
        port, server,
        close: () => new Promise<void>((r) => server.close(() => r())),
        recordHandoff: (h) => { if (h.state === "awaiting_human") pending.set(h.jobId, h); else pending.delete(h.jobId); },
        pendingHandoffs: () => [...pending.values()],
      });
    });
  });
}

function publicSetup(s: AccountSetup) {
  const { handle: _h, ...rest } = s; return rest;
}

function runView(storage: Storage, runId: string, live: Map<string, LaunchHandle>) {
  const run = storage.getRun(runId)!;
  const jobs = storage.getJobsByRun(runId);
  const spentMicro = storage.runSpendMicroUsd(runId);
  const counters = storage.readEventsAfter(runId, 0, 5000).filter((e) => e.type === "counter").map((e) => e.event.data as { url: string; missed: number | "uncertain" });
  return {
    run: { ...run, spentUsd: Number((spentMicro / 1e6).toFixed(6)), capUsd: Number((run.capMicroUsd / 1e6).toFixed(6)), live: live.has(runId) },
    jobs: jobs.map((j) => ({ id: j.id, purpose: j.purpose, competitor: j.competitor, url: j.url, state: j.state, reason: j.reason })),
    counts: { observations: storage.countObservations(runId), events: storage.countEvents(runId), handoffs: storage.countEvents(runId, "handoff") },
    counters,
  };
}
