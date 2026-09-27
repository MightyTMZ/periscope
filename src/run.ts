// End-to-end CLI: Storage (Ayaan) + Steel segment (Fahad) + Coordinator (Tom), wired through src/integration/launch-run.
// The API (src/api) launches runs the same way; this is the one-command form the runbook uses.
//
//   STEEL_API_KEY=... ANTHROPIC_API_KEY=... npx tsx src/run.ts \
//     --competitor ornn --url https://ornn.com --pages /regulatory,/product \
//     --jobs surface,benchmark,reveal --countries CA,US,DE --cap 12
//
//   --jobs map --max-pages 40 maps the whole site first (sitemap + link crawl, PageRank order) and opens the best pages
//   in parallel browsers; PERISCOPE_MAX_CONCURRENT (10 on Launch, 100 on Scale), PERISCOPE_MAP_BROWSERS and PERISCOPE_MAP_PAGES_PER_BROWSER (default 5) shape it.
//
//   add --profile <profileId> --account trial1 --start https://app.example.com to enqueue a walker.
//
// A handoff prints the viewer URL; a human resolves it in the live view and then:
//   curl -X POST http://localhost:4747/jobs/<jobId>/resume
//
// Never commits credentials. Never creates accounts. Releases every session it opened, even on Ctrl+C.

import path from "node:path";
import { Storage } from "@periscope/knowledge";
import type { JobType } from "./coordinator.js";
import { createSteelSegment } from "./steel/segment.js";
import { RouterSink, launchRun } from "./integration/launch-run.js";
import { startResumeServer } from "./integration/resume-server.js";
import type { Event } from "@periscope/contracts";

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  if (v === undefined && fallback === undefined) throw new Error(`--${name} is required`);
  return v ?? (fallback as string);
}

const runId = arg("run-id", `run-${Date.now()}`);
const spec = {
  runId,
  competitor: arg("competitor"),
  url: arg("url"),
  pages: arg("pages", "/").split(",").map((s) => s.trim()).filter(Boolean),
  jobs: arg("jobs", "surface,benchmark,reveal").split(",").map((s) => s.trim()) as Array<JobType | "map">,
  maxPages: Number(arg("max-pages", "400")),
  countries: arg("countries", "CA,US,DE").split(",").map((s) => s.trim()).filter(Boolean),
  capUsd: Number(arg("cap", "12")),
  profileId: process.argv.includes("--profile") ? arg("profile") : undefined,
  accountRef: process.argv.includes("--account") ? arg("account") : undefined,
  start: process.argv.includes("--start") ? arg("start") : undefined,
};

const dataDir = process.env.PERISCOPE_DATA_DIR ?? "./data";
const storage = Storage.open({ path: path.join(dataDir, "periscope.sqlite") });
storage.migrate();

const router = new RouterSink();
const segment = createSteelSegment({ sink: router });
const released = await segment.reconcile();
if (released.length) console.log(`reconciled ${released.length} session(s) left open by a previous run`);

const resume = startResumeServer({ segment });
console.log(`resume endpoint: http://localhost:${resume.port}/jobs/<jobId>/resume`);

const t0 = Date.now();
const handle = launchRun(spec, {
  storage, segment, router, onEvent: logEvent,
  onHandoff: (h) => resume.recordHandoff(h),
});

const shutdown = async () => { console.log("shutting down, releasing sessions..."); resume.close(); storage.close(); process.exit(130); };
process.on("SIGINT", () => void shutdown());

const result = await handle.done;
console.log(`\nrun ${runId} done in ${Math.round((Date.now() - t0) / 1000)}s: ${result.completedJobs.length} completed, ${result.failedJobs.length} failed`);
console.log(`observations: ${storage.countObservations(runId)}  events: ${storage.countEvents(runId)}  spend: $${(storage.runSpendMicroUsd(runId) / 1e6).toFixed(2)}`);
resume.close();
storage.close();

function logEvent(e: Event): void {
  switch (e.type) {
    case "job_state": console.log(`[job ${e.data.jobId.slice(0, 8)}] ${e.data.state}${e.data.reason ? " (" + e.data.reason + ")" : ""}`); break;
    case "handoff": console.log(`[handoff] ${e.data.state} ${e.data.wall} job ${e.data.jobId.slice(0, 8)} generation ${e.data.generation}\n  live view: ${e.data.viewerUrl}`); break;
    case "counter": console.log(`[counter] ${e.data.url} missed by fetch: ${e.data.missed}`); break;
    case "observation": if (e.data.layer === "hidden") console.log(`[hidden] ${e.data.revealedBy?.label ?? e.data.revealedBy?.action ?? "?"}: ${e.data.text.slice(0, 80)}`); break;
    default: break;
  }
}
