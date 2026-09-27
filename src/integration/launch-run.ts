// In-process run launcher shared by the CLI (src/run.ts) and the API (src/api). One Steel segment per process,
// one StorageSink per run, events routed by job id so several runs can share the pool's ten slots.
import { Storage } from "@periscope/knowledge";
import type { Event, EventSink, HandoffEvent, Vantage } from "@periscope/contracts";
import { Coordinator, type Job, type JobType } from "../coordinator.js";
import type { SteelSegment } from "../steel/segment.js";
import { StorageSink } from "./storage-sink.js";
import type { LiveSessions } from "./live-sessions.js";
import { archiveSession, evidenceSink } from "./evidence.js";
import { chunkForBrowsers, discoverSite, isDocumentLink, keywordScore, normalizeUrl, sameSite, type SiteMap } from "../map.js";
import type { Complete } from "../intel/extract.js";
import { planSite } from "../intel/navigator.js";
import { meteredCompletion } from "../intel/metered-completion.js";

export interface RunSpec {
  runId: string;
  competitor: string;
  url: string;
  pages?: string[];          // paths or full urls, resolved against url; default ["/"]
  jobs?: Array<JobType | "map">; // default surface, benchmark, reveal; "map" discovers the whole site first and replaces the page jobs
  maxPages?: number;         // whole-site runs: how many discovered pages get a browser (default 400: the whole site)
  /**
   * Whole-site runs: what to do when the site has a sign-in page. "ask": open it in a browser and hand off to a
   * person, who signs in inside the live view (Periscope never sees the password); the walk then reads the
   * signed-in space. "skip" (default): public pages only.
   */
  login?: "ask" | "skip";
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
  /** Model behind the navigator: when present, Claude labels and orders the site map before browsers open. */
  complete?: Complete;
}

export interface LaunchHandle {
  runId: string;
  coordinator: Coordinator;
  done: Promise<{ completedJobs: Job[]; failedJobs: Job[] }>;
  cancel: () => Promise<void>;
  /** Whole-site runs: the discovered map, once discovery has finished. */
  map?: SiteMap;
  /** Add jobs to a run in flight (the API uses this to restart a login with an injected credential). */
  enqueue?: (jobs: Omit<Job, "id" | "state">[]) => void;
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
    enqueue: (extra) => { coordinator.enqueue(extra); register(); },
    cancel: async () => {
      deps.storage.setRunStatus(spec.runId, "cancelled", "cancelled through the API");
      await coordinator.cancelAll();
    },
  };

  const done = (async () => {
    let stopGrowth: (() => void) | undefined;
    if ((spec.jobs ?? []).includes("map")) {
      // Whole site: find every page over plain fetch, rank them, then spread them across parallel browsers. Sites that
      // render only in a browser (React apps with empty server HTML) show up as a near-empty fetch map; for those the
      // map grows from the links each revealed page carries, until the page budget is met or nothing new appears.
      const pages = resolvePages(spec.url, spec.pages);
      const maxPages = spec.maxPages ?? 400;
      const site = await discoverSite({ root: spec.url, start: pages[0], maxPages, log: (l) => console.log(`[map ${spec.runId}] ${l}`) });
      handle.map = site;
      // The navigator: Claude labels every page and sets the order. Rules already ranked them; the model catches what
      // rules cannot read from a path. Every page still opens; only the order changes.
      if (deps.complete && site.pages.length > 1) {
        try {
          const plan = await planSite({ competitor: spec.competitor, urls: site.pages, complete: meteredCompletion(deps.storage, spec.runId, deps.complete) });
          site.pages = plan.order;
          site.types = Object.fromEntries(plan.types);
          site.read = plan.read;
          console.log(`[map ${spec.runId}] navigator: ${plan.read || "planned"} (${plan.types.size} pages labelled)`);
        } catch (err) { console.warn(`[map ${spec.runId}] navigator skipped: ${(err as Error).message.slice(0, 120)}`); }
      }
      const desktop: Vantage = { country: null, device: "desktop", authenticated: false };
      const cap = Math.max(1, Number(process.env.PERISCOPE_MAX_CONCURRENT ?? 10));
      // the reveal of each page also calls Steel's scrape endpoint (a short-lived session of its own), so leave two slots free by default
      const browsers = Math.max(1, Math.min(cap, Number(process.env.PERISCOPE_MAP_BROWSERS ?? Math.max(1, cap - 2))));
      const perBrowser = Math.max(1, Number(process.env.PERISCOPE_MAP_PAGES_PER_BROWSER ?? 3));

      const known = new Set<string>(site.pages);
      const waiting: string[] = [];
      const enqueuePages = (urls: string[]) => {
        coordinator.enqueue([
          { type: "reveal", competitor: spec.competitor, urls, vantage: desktop, onLinks },
          { type: "benchmark", competitor: spec.competitor, urls, vantage: desktop },
        ]);
        register();
      };
      const flush = (force: boolean) => {
        while (waiting.length >= perBrowser || (force && waiting.length)) enqueuePages(waiting.splice(0, perBrowser));
      };
      const onLinks = (pageUrl: string, links: string[]) => {
        const fresh: string[] = [];
        for (const raw of links) {
          if (known.size >= maxPages) break;
          const n = normalizeUrl(raw, spec.url); // links are absolute; the base only pins the host form the map uses
          if (!n) continue;
          if (/\/(log-?in|sign-?in|signin|auth)(\/|$|\?|#)|^https?:\/\/(app|login|auth|account|accounts|dashboard|portal|my|console)\./i.test(n) && !site.loginCandidates.includes(n)) site.loginCandidates.push(n);
          if (!sameSite(n, spec.url) || known.has(n)) continue;
          if (isDocumentLink(n)) { if (!site.documents.includes(n)) site.documents.push(n); continue; }
          if (keywordScore(n) <= -5) continue; // login, cart, legal, tag pages: never worth a browser
          known.add(n);
          fresh.push(n);
        }
        if (!fresh.length) return;
        fresh.sort((a, b) => keywordScore(b) - keywordScore(a));
        site.pages.push(...fresh);
        site.nodes += fresh.length;
        waiting.push(...fresh);
        console.log(`[map ${spec.runId}] +${fresh.length} pages from ${pageUrl} (${known.size} known)`);
        flush(false);
        // if this is the last browser still working, do not hold the remainder for a fuller batch
        const st = coordinator.getState();
        if (!st.queued.length && st.running.length <= 1) flush(true);
      };
      // pages that arrive in twos and threes still get a browser: flush the remainder every few seconds
      const timer = setInterval(() => flush(true), 8000);
      stopGrowth = () => clearInterval(timer);

      // The sign-in door: when asked, open it in its own browser and hand off to a person. The walker detects the login
      // wall, the console shows the wall card, the person signs in inside the live view, presses resume, and the walk
      // reads every screen behind the door. Without an account of their own there is nothing to do here.
      if (spec.login === "ask") {
        const door = await findLoginUrl(spec.url, [...site.loginCandidates, ...site.scores.keys()]);
        if (door) {
          console.log(`[map ${spec.runId}] sign-in page ${door}: a person will be asked to log in`);
          coordinator.enqueue([{ type: "walker", competitor: spec.competitor, urls: [door], vantage: { country: null, device: "desktop", authenticated: true }, revealEverything: true }]);
          register();
        } else console.log(`[map ${spec.runId}] no sign-in page found on this site`);
      }

      const chunks = chunkForBrowsers(site.pages, browsers, perBrowser);
      console.log(`[map ${spec.runId}] ${site.nodes} pages known (${site.sitemap ? "sitemap + " : ""}${site.fetched} fetched), opening ${site.pages.length} in ${chunks.length} browsers${site.pages.length <= 2 ? "; the map will grow from what the browser renders" : ""}`);
      coordinator.enqueue([{ type: "benchmark", competitor: spec.competitor, urls: site.pages, vantage: desktop }]);
      for (const urls of chunks) coordinator.enqueue([{ type: "reveal", competitor: spec.competitor, urls, vantage: desktop, onLinks }]);
      register();
    }
    const result = await coordinator.run();
    stopGrowth?.();
    await tee.write({ type: "run_done", data: { runId: spec.runId } });
    return result;
  })();

  handle.done = done;
  return handle;
}

const LOGIN_PATH = /\/(log-?in|sign-?in|signin|auth|account\/login|users\/sign_in|session\/new)(\/|$|\?|#)/i;

/** The site's sign-in page: from the map when it links to one, else the usual paths, probed over plain fetch. */
export async function findLoginUrl(root: string, known: string[], fetchImpl: typeof fetch = fetch): Promise<string | undefined> {
  const fromMap = known.filter((u) => LOGIN_PATH.test(u)).sort((a, b) => a.length - b.length)[0];
  if (fromMap) return fromMap;
  const origin = new URL(root).origin;
  for (const path of ["/login", "/signin", "/sign-in", "/account/login", "/users/sign_in", "/auth/login"]) {
    const url = origin + path;
    try {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 8000);
      const r = await fetchImpl(url, { redirect: "follow", signal: ctl.signal, headers: { accept: "text/html" } });
      clearTimeout(t);
      // a real sign-in page answers 200 and stays on a sign-in path (a soft 404 or a redirect home does not)
      if (r.ok && LOGIN_PATH.test(new URL(r.url || url).pathname + "/")) return url;
    } catch { /* not there */ }
  }
  return undefined;
}
