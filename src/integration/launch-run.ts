// In-process run launcher shared by the CLI (src/run.ts) and the API (src/api). One Steel segment per process,
// one StorageSink per run, events routed by job id so several runs can share the pool's ten slots.
import { Storage } from "@periscope/knowledge";
import type { Event, EventSink, HandoffEvent, Vantage } from "@periscope/contracts";
import { Coordinator, type Job, type JobType } from "../coordinator.js";
import type { SteelSegment } from "../steel/segment.js";
import { StorageSink } from "./storage-sink.js";
import type { LiveSessions } from "./live-sessions.js";
import { archiveSession, evidenceSink } from "./evidence.js";
import { chunkForBrowsers, discoverSite, type SiteMap } from "../map.js";

export interface RunSpec {
  runId: string;
  competitor: string;
  url: string;
  pages?: string[];          // paths or full urls, resolved against url; default ["/"]
  jobs?: Array<JobType | "map">; // default surface, benchmark, reveal; "map" discovers the whole site first and replaces the page jobs
  maxPages?: number;         // whole-site runs: how many discovered pages get a browser (default 400: the whole site)
  countries?: string[];      // default CA, US, DE (borders and the walker's home country)
  capUsd?: number;           // default 12
  start?: string;            // walker start url
  profileId?: string;
  accountRef?: string;
  category?: string;
  goal?: string;
}

export interface LaunchDeps {
  storage: Storage;
  segment: Pick<SteelSegment, "acquireSession" | "steel" | "onWall" | "waitForResolution"> & Partial<Pick<SteelSegment, "handoff" | "notifier" | "adapter">>;
  router: RouterSink;
  live?: LiveSessions;
  onEvent?: (e: Event) => void;
  onHandoff?: (h: HandoffEvent) => void;
}

export interface LaunchHandle {
  runId: string;
  coordinator: Coordinator;
  done: Promise<{ completedJobs: Job[]; failedJobs: Job[] }>;
  cancel: () => Promise<void>;
  /** Whole-site runs: the discovered map, once discovery has finished. */
  map?: SiteMap;
}

/** Routes segment-level events (handoffs) to the run that owns the job. */
export class RouterSink implements EventSink {
  private readonly byJob = new Map<string, EventSink>();
  register(jobId: string, sink: EventSink): void { this.byJob.set(jobId, sink); }
  async write(event: Event): Promise<void> {
    const jobId = "jobId" in event.data ? (event.data as { jobId?: string }).jobId : undefined;
    const sink = jobId ? this.byJob.get(jobId) : undefined;
    if (sink) await sink.write(event);
    else console.warn(`[router] event ${event.type} for unknown job ${jobId ?? "?"} dropped`);
  }
}

export function resolvePages(root: string, pages: string[] | undefined): string[] {
  return (pages && pages.length ? pages : ["/"]).map((p) => {
    const raw = p.trim();
    // Git Bash on Windows rewrites a leading "/" argument into "C:/Program Files/Git/..." before Node sees it.
    if (/^[a-z]:[\/]/i.test(raw) || raw.startsWith("file:")) throw new Error(`page "${raw}" looks like a local path. Run with MSYS_NO_PATHCONV=1 or pass full URLs.`);
    return new URL(raw, root).toString();
  });
}

export function buildJobs(spec: RunSpec): Omit<Job, "id" | "state">[] {
  const pages = resolvePages(spec.url, spec.pages);
  const countries = spec.countries ?? ["CA", "US", "DE"];
  const desktop: Vantage = { country: null, device: "desktop", authenticated: false };
  const jobs: Omit<Job, "id" | "state">[] = [];
  const wanted = spec.jobs ?? ["surface", "benchmark", "reveal"];
  const map = wanted.includes("map");
  for (const t of wanted) {
    // whole-site runs get their page jobs from discovery (see launchRun), so the plain page jobs are skipped here
    if (!map && (t === "surface" || t === "benchmark" || t === "reveal")) jobs.push({ type: t, competitor: spec.competitor, urls: pages, vantage: desktop });
    if (t === "borders") jobs.push({ type: "borders", competitor: spec.competitor, urls: [pages[0]], vantages: countries.flatMap((c) => [{ country: c, device: "desktop", authenticated: false }, { country: c, device: "mobile", authenticated: false }] as Vantage[]) });
    if (t === "walker") {
      if (!spec.start) throw new Error("start url is required for a walker job");
      jobs.push({ type: "walker", competitor: spec.competitor, urls: [spec.start], vantage: { country: countries[0] ?? null, device: "desktop", authenticated: true }, profileId: spec.profileId, accountRef: spec.accountRef });
    }
  }
  return jobs;
}

export function launchRun(spec: RunSpec, deps: LaunchDeps): LaunchHandle {
  const capUsd = spec.capUsd ?? 12;
  const jobs = buildJobs(spec);
  const jobHints = new Map<string, { purpose: "surface" | "reveal" | "borders" | "walker" | "setup"; competitor: string; url?: string }>();
  const store: EventSink = new StorageSink({ storage: deps.storage, runId: spec.runId, category: spec.category ?? "demo", capUsd, jobHints: (id) => jobHints.get(id) });
  const evidence = evidenceSink(deps.storage, store);
  const tee: EventSink = {
    async write(event: Event) {
      await evidence.write(event);
      deps.onEvent?.(event);
      if (event.type === "handoff") deps.onHandoff?.(event.data);
    },
  };

  const acquire: SteelSegment["acquireSession"] = async (req) => {
    const h = await deps.segment.acquireSession(req);
    const release = h.release.bind(h);
    let releasing: Promise<void> | undefined;
    h.release = () => releasing ??= (async () => {
      await release();
      if (deps.segment.adapter) await archiveSession(deps.storage, deps.segment.adapter, spec.runId, h);
    })();
    return h;
  };
  const coordinator = new Coordinator({
    runId: spec.runId, runBudgetUsd: capUsd, jobBudgetUsd: Math.min(capUsd, 4), runStartedAt: new Date().toISOString(),
    sink: tee, acquireSession: deps.live ? deps.live.wrap(spec.runId, spec.competitor, acquire) : acquire, steel: deps.segment.steel,
    onWall: (wall, handle) => deps.segment.onWall(wall, handle),
    waitForResolution: deps.segment.waitForResolution,
    cancelHandoff: async (jobId) => { await deps.segment.handoff?.cancel(jobId); deps.segment.notifier?.stop(jobId); },
  });
  const register = () => {
    for (const j of coordinator.getState().queued) {
      if (jobHints.has(j.id)) continue;
      jobHints.set(j.id, { purpose: j.type === "walker" ? "walker" : j.type === "borders" ? "borders" : j.type === "reveal" ? "reveal" : "surface", competitor: spec.competitor, url: j.urls[0] });
      deps.router.register(j.id, tee);
    }
  };
  coordinator.enqueue(jobs);
  register();

  const handle: LaunchHandle = {
    runId: spec.runId, coordinator, done: Promise.resolve({ completedJobs: [], failedJobs: [] }),
    cancel: async () => {
      deps.storage.setRunStatus(spec.runId, "cancelled", "cancelled through the API");
      await coordinator.cancelAll();
    },
  };

  const done = (async () => {
    if ((spec.jobs ?? []).includes("map")) {
      // Whole site: find every page over plain fetch, rank them, then spread the best ones across parallel browsers.
      const pages = resolvePages(spec.url, spec.pages);
      const site = await discoverSite({ root: spec.url, start: pages[0], maxPages: spec.maxPages ?? 400, log: (l) => console.log(`[map ${spec.runId}] ${l}`) });
      handle.map = site;
      const desktop: Vantage = { country: null, device: "desktop", authenticated: false };
      const cap = Math.max(1, Number(process.env.PERISCOPE_MAX_CONCURRENT ?? 10));
      // Each reveal job holds one browser AND briefly opens a second session for its scrape baseline, so N reveal jobs
      // can need up to 2N sessions at once. To never trip Steel's "concurrent session limit", cap the reveal browsers
      // at half the plan (a whole-site run of 50 pages queues through them in waves). One env override if wanted.
      const safe = Math.max(1, Math.floor(cap / 2));
      const browsers = Math.max(1, Math.min(safe, Number(process.env.PERISCOPE_MAP_BROWSERS ?? safe)));
      const chunks = chunkForBrowsers(site.pages, browsers, Number(process.env.PERISCOPE_MAP_PAGES_PER_BROWSER ?? 3));
      console.log(`[map ${spec.runId}] ${site.nodes} pages known (${site.sitemap ? "sitemap + " : ""}${site.fetched} fetched), opening ${site.pages.length} in ${chunks.length} browsers`);
      coordinator.enqueue([
        { type: "benchmark", competitor: spec.competitor, urls: site.pages, vantage: desktop },
        ...chunks.map((urls) => ({ type: "reveal" as const, competitor: spec.competitor, urls, vantage: desktop })),
      ]);
      register();
    }
    const result = await coordinator.run();
    await tee.write({ type: "run_done", data: { runId: spec.runId } });
    return result;
  })();

  handle.done = done;
  return handle;
}
