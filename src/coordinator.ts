import { randomUUID } from "node:crypto";
import type {
  LeaseRequest,
  SessionHandle,
  EventSink,
  JobState,
  Vantage,
  WallDetected,
  HandoffEvent,
} from "@periscope/contracts";
import { Meter, BudgetExceededError } from "./meter.js";
import { Policy } from "./policy.js";
import { scrapeSurface } from "./surface.js";
import { fetchBenchmark } from "./benchmark.js";
import { reveal } from "./reveal.js";
import { revealDeterministic } from "./reveal-deterministic.js";
import { walk } from "./walker.js";
import { walkDeterministic } from "./walker-deterministic.js";
import { runBorders } from "./borders.js";
import { createStagehand } from "./utils/stagehand-bridge.js";
import Steel from "steel-sdk";
import { abortable } from "./utils/cancellation.js";

export type JobType = "surface" | "benchmark" | "reveal" | "borders" | "walker";

export interface Job {
  id: string;
  type: JobType;
  competitor: string;
  urls: string[];
  vantage?: Vantage;
  vantages?: Vantage[]; // for borders
  profileId?: string;
  accountRef?: string;
  state: JobState;
  reason?: string;
  /** Reveal jobs: called with every link the rendered page carried; whole-site runs grow their map from it. */
  onLinks?: (pageUrl: string, links: string[]) => void;
  /** Walker jobs: open every control on every screen, not just links, and allow more screens. */
  revealEverything?: boolean;
  /** Walker jobs: a login the person typed into the console, in memory only; never persisted or logged. */
  typedLogin?: { username: string; password: string };
}

export interface CoordinatorConfig {
  runId: string;
  runBudgetUsd: number;
  jobBudgetUsd: number;
  runStartedAt: string;
  sink: EventSink;
  acquireSession: (req: LeaseRequest) => Promise<SessionHandle>;
  steel: Steel;
  /**
   * Segment C (Fahad): human-in-the-loop hooks. When present, a wall raised by the walker goes to onWall,
   * the session is kept alive until the human resumes or abandons, and the walk continues afterwards.
   * Without them the old behaviour applies: the job is marked awaiting_human and the session is released.
   */
  onWall?: (wall: WallDetected, handle: SessionHandle) => Promise<HandoffEvent | { jobId: string; state: "solved_by_steel" }>;
  waitForResolution?: (jobId: string) => Promise<"resumed" | "abandoned">;
  cancelHandoff?: (jobId: string) => Promise<void>;
}

/** Matches the Steel plan: 10 on Launch, 100 on Scale. Same knob as the session pool. */
const MAX_CONCURRENT = Math.max(1, Number(process.env.PERISCOPE_MAX_CONCURRENT ?? 10));

/**
 * Job queue over Person C's session pool.
 * One job = one session = one agent. Max 10 concurrent.
 *
 * Demo order: walkers first, reveal jobs fill remaining slots,
 * borders after walkers release.
 *
 * Never more than one agent per session.
 * Never an agent that creates jobs or sessions.
 */
export class Coordinator {
  private config: CoordinatorConfig;
  private meter: Meter;
  private policy: Policy;
  private jobs: Job[] = [];
  private running = new Set<string>();
  private controllers = new Map<string, AbortController>();
  private handles = new Map<string, Set<SessionHandle>>();

  constructor(config: CoordinatorConfig) {
    this.config = config;
    this.meter = new Meter({
      jobBudgetUsd: config.jobBudgetUsd,
      runBudgetUsd: config.runBudgetUsd,
      sink: config.sink,
    });
    this.policy = new Policy();
  }

  /**
   * Enqueue jobs for a run.
   */
  enqueue(jobs: Omit<Job, "id" | "state">[]): void {
    for (const job of jobs) {
      this.jobs.push({
        ...job,
        id: randomUUID(),
        state: "queued",
      });
    }
  }

  /**
   * Start processing the queue. Returns when all jobs complete or budget exhausted.
   */
  async run(): Promise<{ completedJobs: Job[]; failedJobs: Job[] }> {
    // Sort: walkers first, then reveal, then borders, then surface/benchmark
    const priority: Record<JobType, number> = {
      walker: 0,
      reveal: 1,
      borders: 2,
      surface: 3,
      benchmark: 4,
    };
    this.jobs.sort((a, b) => priority[a.type] - priority[b.type]);

    const promises = new Set<Promise<void>>();

    // Jobs enqueued while the run is in flight (a whole-site run grows as pages reveal their links) are picked up
    // too: keep going until the queue is drained and nothing is running.
    let next = 0;
    while (true) {
      while (next < this.jobs.length) {
        const job = this.jobs[next++];
        // Wait if at capacity
        while (this.running.size >= MAX_CONCURRENT) {
          await Promise.race(promises);
        }
        if (job.state === "cancelled") continue;

        // Check run budget
        if (!this.meter.canProceed(job.id)) {
          job.state = "cancelled";
          job.reason = "Run budget exceeded";
          await this.emitJobState(job);
          continue;
        }

        this.running.add(job.id);
        this.controllers.set(job.id, new AbortController());
        const p = this.executeJob(job).finally(() => {
          this.running.delete(job.id);
          promises.delete(p);
        });
        promises.add(p);
      }
      if (!promises.size) break;
      await Promise.race(promises);
    }

    // Wait for all to complete
    await Promise.allSettled(promises);

    return {
      completedJobs: this.jobs.filter(
        (j) => j.state === "completed" || j.state === "partial",
      ),
      failedJobs: this.jobs.filter((j) => j.state === "failed"),
    };
  }

  /**
   * Cancel a running job.
   */
  async cancel(jobId: string): Promise<void> {
    const job = this.jobs.find((j) => j.id === jobId);
    if (job && !["completed", "failed", "partial", "cancelled"].includes(job.state)) {
      job.state = "cancelled";
      job.reason = "Manually cancelled";
      this.controllers.get(jobId)?.abort(new Error("Run cancelled"));
      await this.config.cancelHandoff?.(jobId);
      await Promise.allSettled([...(this.handles.get(jobId) ?? [])].map((h) => h.release()));
      await this.emitJobState(job);
    }
  }

  async cancelAll(): Promise<void> {
    await Promise.all(this.jobs.map((job) => this.cancel(job.id)));
  }

  private signal(job: Job): AbortSignal { return this.controllers.get(job.id)!.signal; }

  private async acquire(job: Job, req: LeaseRequest): Promise<SessionHandle> {
    const signal = this.signal(job);
    signal.throwIfAborted();
    const handle = await abortable(this.config.acquireSession(req), signal, (h) => h.release());
    const owned = this.handles.get(job.id) ?? new Set<SessionHandle>();
    owned.add(handle); this.handles.set(job.id, owned);
    const release = handle.release.bind(handle);
    let releasing: Promise<void> | undefined;
    handle.release = () => releasing ??= release().finally(() => owned.delete(handle));
    return handle;
  }

  /**
   * Get current state.
   */
  getState(): {
    queued: Job[];
    running: Job[];
    completed: Job[];
    failed: Job[];
  } {
    return {
      queued: this.jobs.filter((j) => j.state === "queued"),
      running: this.jobs.filter((j) => j.state === "running"),
      completed: this.jobs.filter(
        (j) => j.state === "completed" || j.state === "partial",
      ),
      failed: this.jobs.filter(
        (j) => j.state === "failed" || j.state === "cancelled",
      ),
    };
  }

  private async emitJobState(job: Job): Promise<void> {
    await this.config.sink.write({
      type: "job_state",
      data: { jobId: job.id, state: job.state, reason: job.reason },
    });
  }

  private async executeJob(job: Job): Promise<void> {
    job.state = "starting";
    await this.emitJobState(job);

    try {
      job.state = "running";
      await this.emitJobState(job);

      await abortable((async () => { switch (job.type) {
        case "surface":
          await this.runSurface(job);
          break;
        case "benchmark":
          await this.runBenchmark(job);
          break;
        case "reveal":
          await this.runReveal(job);
          break;
        case "walker":
          await this.runWalker(job);
          break;
        case "borders":
          await this.runBordersJob(job);
          break;
      } })(), this.signal(job));

      if (job.state === "running") {
        job.state = "completed";
      }
    } catch (err) {
      if (this.signal(job).aborted) {
        job.state = "cancelled";
        job.reason = "Manually cancelled";
      } else if (err instanceof BudgetExceededError) {
        job.state = "partial";
        job.reason = err.message;
      } else {
        job.state = "failed";
        job.reason = err instanceof Error ? err.message : String(err);
      }
    }

    await this.emitJobState(job);
  }

  private async runSurface(job: Job): Promise<void> {
    for (const url of job.urls) {
      this.signal(job).throwIfAborted();
      await scrapeSurface({
        steel: this.config.steel,
        url,
        competitor: job.competitor,
        runId: this.config.runId,
        jobId: job.id,
        vantage: job.vantage ?? {
          country: null,
          device: "desktop",
          authenticated: false,
        },
        sink: this.config.sink,
      });
    }
  }

  private async runBenchmark(job: Job): Promise<void> {
    for (const url of job.urls) {
      this.signal(job).throwIfAborted();
      await fetchBenchmark({
        url,
        competitor: job.competitor,
        runId: this.config.runId,
        jobId: job.id,
        runStartedAt: this.config.runStartedAt,
        vantage: job.vantage ?? {
          country: null,
          device: "desktop",
          authenticated: false,
        },
        sink: this.config.sink,
      });
    }
  }

  private async runReveal(job: Job): Promise<void> {
    const vantage = job.vantage ?? {
      country: null,
      device: "desktop",
      authenticated: false,
    };

    const handle = await this.acquire(job, {
      vantage,
      purpose: "reveal",
    });

    try {
      // Deterministic Playwright strategies run first and need no model. Tom's Stagehand reveal is the fallback for
      // layouts the rules do not recognise, and only runs when a model key is configured.
      const useModel = process.env.PERISCOPE_STAGEHAND === "1" && Boolean(process.env.ANTHROPIC_API_KEY); // opt in: Stagehand on Steel attaches (extension) but its page handling is not stable yet
      // Stagehand attaches after the first navigation: connecting on about:blank leaves its extension without a page (verified live on Steel).
      let sh: Awaited<ReturnType<typeof createStagehand>> | undefined;
      let page = handle.page;

      try {
        for (let i = 0; i < job.urls.length; i++) {
          const url = job.urls[i];
          // A session stops autonomous work at its deadline. If the next page would not fit, hand the remaining pages to a
          // fresh browser instead of losing them when this one is closed under us.
          const msLeft = new Date(handle.deadlineAt).getTime() - Date.now();
          if (i > 0 && msLeft < 4 * 60_000) {
            const rest = job.urls.slice(i);
            this.enqueue([{ type: "reveal", competitor: job.competitor, urls: rest, vantage: job.vantage, onLinks: job.onLinks }]);
            job.urls = job.urls.slice(0, i);
            break;
          }
          await page.goto(url, { waitUntil: "load", timeout: 60_000 });
          await page.waitForTimeout(1000);

          // Get surface baseline for this URL
          const surfaceResult = await scrapeSurface({
            steel: this.config.steel,
            url,
            competitor: job.competitor,
            runId: this.config.runId,
            jobId: job.id,
            vantage,
            sink: this.config.sink,
          });
          const surfaceBaseline = surfaceResult.rawMarkdown || surfaceResult.rawHtml;

          const revealed = await revealDeterministic({
            runId: this.config.runId,
            jobId: job.id,
            competitor: job.competitor,
            url,
            surfaceBaseline,
            page,
            handle,
            sink: this.config.sink,
          });
          if (job.onLinks) { try { job.onLinks(url, revealed.links); } catch { /* the map is best-effort */ } }

          if (useModel && !sh) sh = await createStagehand(handle, { meter: this.meter, sink: this.config.sink, jobId: job.id, runId: this.config.runId });
          if (sh) {
            page = sh.page;
            await reveal({
              runId: this.config.runId,
              jobId: job.id,
              competitor: job.competitor,
              url,
              surfaceBaseline,
              stagehand: sh.stagehand,
              page,
              handle,
              meter: this.meter,
              policy: this.policy,
              sink: this.config.sink,
            });
          }
        }
      } finally {
        await sh?.close();
      }
    } finally {
      await handle.release();
    }
  }

  private async runWalker(job: Job): Promise<void> {
    const vantage = job.vantage ?? {
      country: null,
      device: "desktop",
      authenticated: true,
    };

    const handle = await this.acquire(job, {
      vantage,
      profileId: job.profileId,
      accountRef: job.accountRef,
      purpose: "walker",
    });

    try {
      // Without a model key the deterministic walker (segment C) crawls links; with one, Tom's Stagehand walker operates controls.
      const useModel = process.env.PERISCOPE_STAGEHAND === "1" && Boolean(process.env.ANTHROPIC_API_KEY); // opt in: Stagehand on Steel attaches (extension) but its page handling is not stable yet
      if (useModel) await handle.page.goto(job.urls[0], { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => undefined); // Stagehand needs a real page before it attaches
      const sh = useModel ? await createStagehand(handle, { meter: this.meter, sink: this.config.sink, jobId: job.id, runId: this.config.runId }) : undefined;
      const page = sh?.page ?? handle.page;
      const stagehand = sh?.stagehand;

      try {
        // Segment C integration: a wall pauses the walk, a human (or Steel's CAPTCHA solver) clears it in the SAME
        // session, and the walk resumes. Bounded so a wall that keeps reappearing cannot loop forever.
        let startUrl = job.urls[0];
        for (let attempt = 0; attempt < 3; attempt++) {
          this.signal(job).throwIfAborted();
          const result = stagehand
            ? await walk({
                runId: this.config.runId,
                jobId: job.id,
                competitor: job.competitor,
                startUrl,
                stagehand,
                page,
                handle,
                meter: this.meter,
                policy: this.policy,
                sink: this.config.sink,
              })
            : await walkDeterministic({
                runId: this.config.runId,
                jobId: job.id,
                competitor: job.competitor,
                startUrl,
                page,
                handle,
                sink: this.config.sink,
                autoLogin: Boolean(job.accountRef), // Steel injects the stored credentials for this account; the walker signs in by itself
                typedLogin: job.typedLogin,
                // signed-in spaces hide most of their facts behind tabs, expanders and menus: run the full reveal on every screen
                revealOnScreens: job.revealEverything ? ["consent", "tabs", "selects", "toggles", "showMore", "hover", "modals", "documents", "menus", "sweep"] : undefined,
                maxScreens: job.revealEverything ? 150 : undefined,
              });

          if (result.stoppedReason === "budget") {
            job.state = "partial";
            job.reason = "Budget exceeded";
            break;
          }
          if (!result.wallDetected) break;
          if (attempt === 2) {
            job.state = "partial";
            job.reason = "Wall retry limit reached";
            break;
          }

          if (!this.config.onWall || !this.config.waitForResolution) {
            job.state = "awaiting_human";
            await this.emitJobState(job);
            break;
          }
          const outcome = await this.config.onWall(result.wallDetected, handle);
          if (outcome.state === "solved_by_steel") {
            startUrl = page.url();
            continue;
          }
          const resolution = await abortable(this.config.waitForResolution(job.id), this.signal(job));
          if (resolution === "abandoned") {
            job.state = "partial";
            job.reason = `wall ${result.wallDetected.wall} not resolved by a human`;
            break;
          }
          job.state = "running";
          startUrl = page.url();
        }
      } finally {
        await sh?.close();
      }
    } finally {
      await handle.release();
    }
  }

  private async runBordersJob(job: Job): Promise<void> {
    if (!job.vantages || job.vantages.length === 0) return;

    // Get surface baseline
    const surfaceResult = await scrapeSurface({
      steel: this.config.steel,
      url: job.urls[0],
      competitor: job.competitor,
      runId: this.config.runId,
      jobId: job.id,
      vantage: { country: null, device: "desktop", authenticated: false },
      sink: this.config.sink,
    });

    await runBorders({
      runId: this.config.runId,
      jobId: job.id,
      competitor: job.competitor,
      url: job.urls[0],
      vantages: job.vantages,
      surfaceBaseline: surfaceResult.rawMarkdown || surfaceResult.rawHtml,
      meter: this.meter,
      policy: this.policy,
      sink: this.config.sink,
      acquireSession: (req) => this.acquire(job, req),
    });
  }
}
