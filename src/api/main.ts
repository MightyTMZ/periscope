// API entry point: npx tsx src/api/main.ts  (PERISCOPE_API_PORT, PERISCOPE_DATA_DIR, STEEL_API_KEY)
// Without STEEL_API_KEY every read endpoint still works from SQLite; POST /runs and account setups answer 503.
import path from "node:path";
import { Corpus, MiniLmEmbedder, QdrantVectorStore, Storage, corpusConfigFromEnv } from "@periscope/knowledge";
import { createSteelSegment } from "../steel/segment.js";
import { RouterSink, launchRun } from "../integration/launch-run.js";
import { LiveSessions } from "../integration/live-sessions.js";
import { createApi } from "./server.js";
import { anthropicComplete } from "../intel/extract.js";
import { sweepScreenshots } from "../utils/housekeeping.js";
import { ExtractionWorker } from "../intel/extraction-worker.js";

const dataDir = process.env.PERISCOPE_DATA_DIR ?? "./data";
// Keep the data volume from filling with screenshots: sweep at start and every ten minutes.
{
  const r = sweepScreenshots(dataDir);
  if (r.removed) console.log(`[housekeeping] screenshots: removed ${r.removed} old files, ${(r.after / 1e6).toFixed(0)} MB kept`);
  setInterval(() => { const x = sweepScreenshots(dataDir); if (x.removed) console.log(`[housekeeping] screenshots: removed ${x.removed}, ${(x.after / 1e6).toFixed(0)} MB kept`); }, 10 * 60_000).unref();
}
const storage = Storage.open({ path: path.join(dataDir, "periscope.sqlite") });
storage.migrate();

const hasSteel = Boolean(process.env.STEEL_API_KEY);
const complete = process.env.ANTHROPIC_API_KEY ? anthropicComplete() : undefined;
const autoExtract = Boolean(complete) && process.env.PERISCOPE_AUTO_EXTRACT !== "0";
const semanticEnabled = process.env.PERISCOPE_SEMANTIC === "1";
const corpus = semanticEnabled ? (() => {
  const cfg = corpusConfigFromEnv();
  return new Corpus({ storage, embedder: new MiniLmEmbedder({ modelName: cfg.modelName, dimension: cfg.vectorSize, cacheDir: cfg.modelCacheDir }), vectors: new QdrantVectorStore({ url: cfg.qdrantUrl, collection: cfg.collection, apiKey: cfg.qdrantApiKey }) });
})() : undefined;
const router = new RouterSink();
const live = new LiveSessions();
const segment = hasSteel ? createSteelSegment({ sink: router }) : undefined;
if (segment) {
  const released = await segment.reconcile();
  if (released.length) console.log(`reconciled ${released.length} session(s) left open by a previous run`);
}

const api = await createApi({
  storage,
  corpus,
  complete,
  liveSessions: segment ? (runId) => live.view(segment.pool.activeSessions(), runId) : undefined,
  segment: segment ? { resume: segment.resume, acquireSession: segment.acquireSession, profileStatus: (id) => segment.adapter.profileStatus(id), storeCredential: (i) => segment.adapter.storeCredential(i), abandon: (jobId, reason) => segment.handoff.abandon(jobId, reason) } : undefined,
  launch: segment ? (spec) => launchRun(spec, {
    storage, segment, router, live, complete,
    onEvent: (e) => { if (e.type === "job_state") console.log(`[${spec.runId}] job ${e.data.jobId.slice(0, 8)} ${e.data.state}${e.data.reason ? " (" + e.data.reason + ")" : ""}`); if (e.type === "counter") console.log(`[${spec.runId}] ${e.data.url} missed by fetch: ${e.data.missed}`); },
    onHandoff: (h) => { api.recordHandoff(h); console.log(`[${spec.runId}] handoff ${h.state} ${h.wall} job ${h.jobId.slice(0, 8)} -> ${h.viewerUrl}`); },
  }) : undefined,
});
if (autoExtract) {
  const startedAt = new Date().toISOString();
  const extractor = new ExtractionWorker(storage, complete!, startedAt);
  setInterval(() => void extractor.tick(), 5000).unref();
}
if (corpus) {
  void corpus.ensureCollection().then(() => setInterval(() => void corpus.indexPending().catch((e) => console.warn(`[semantic] ${e.message}`)), 5000).unref()).catch((e) => console.warn(`[semantic] disabled: ${e.message}`));
}
console.log(`periscope api on http://localhost:${api.port} (steel ${hasSteel ? "on" : "off, read-only"}, model ${complete ? "on" : "off"}); contract in docs/api.md`);

const shutdown = async () => { console.log("shutting down"); await api.close(); storage.close(); process.exit(130); };
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
