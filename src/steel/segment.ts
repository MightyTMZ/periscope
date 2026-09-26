// Owner: Fahad. The one object Person B's coordinator needs from segment C.
//
// Usage in the coordinator:
//   const c = createSteelSegment({ sink });
//   new Coordinator({ ..., acquireSession: c.acquireSession, steel: c.steel });
//   // when a walker returns wallDetected, call c.onWall(wallDetected, handle) BEFORE releasing the handle,
//   // and only release once the returned promise says the job resumed or was abandoned.

import Steel from "steel-sdk";
import type { EventSink, LeaseRequest, SessionHandle, WallDetected } from "@periscope/contracts";
import { SteelAdapter } from "./steel-adapter.js";
import { SessionPool } from "./pool.js";
import { HandoffController, type JobDriver } from "./handoff.js";
import { Notifier } from "./notifier.js";
import { ensureStagehandExtension } from "./stagehand-extension.js";
import { loadProfiles } from "./profiles.js";
import { credentialNamespace } from "./credentials.js";

export interface SteelSegmentOptions {
  sink: EventSink;
  driver?: JobDriver;            // the coordinator's pause/resume hooks; a no-op driver is used if absent
  apiKey?: string;               // defaults to STEEL_API_KEY
  solveCaptcha?: boolean;        // defaults to STEEL_CAPTCHA=1
  proxyUrl?: string;             // defaults to PERISCOPE_PROXY_URL
  webhookUrl?: string;           // defaults to PERISCOPE_WEBHOOK_URL
}

export interface SteelSegment {
  steel: Steel;
  adapter: SteelAdapter;
  pool: SessionPool;
  handoff: HandoffController;
  notifier: Notifier;
  acquireSession: (req: LeaseRequest) => Promise<SessionHandle>;
  /** C11: release sessions this app left live before a crash. Call once at startup. */
  reconcile: () => Promise<string[]>;
  onWall: (wall: WallDetected, handle: SessionHandle) => ReturnType<HandoffController["onWall"]>;
  resume: (jobId: string, generation: number) => ReturnType<HandoffController["resume"]>;
  waitForResolution: (jobId: string) => Promise<"resumed" | "abandoned">;
}

const noopDriver: JobDriver = {
  async pause() {}, discardPending() {}, resume() {}, async fail() {},
};

export function createSteelSegment(opts: SteelSegmentOptions): SteelSegment {
  const apiKey = opts.apiKey ?? process.env.STEEL_API_KEY ?? "";
  const adapter = new SteelAdapter({
    apiKey,
    // Model-driven passes (reveal, walker) need Stagehand's extension inside the Steel session; setup and borders do not.
    extensionIdsFor: async (req) => {
      if (process.env.PERISCOPE_STAGEHAND !== "1" || !process.env.ANTHROPIC_API_KEY || req.purpose === "setup" || req.purpose === "borders") return [];
      const id = await ensureStagehandExtension(adapter.client);
      return id ? [id] : [];
    },
    proxyUrl: opts.proxyUrl ?? (process.env.PERISCOPE_PROXY_URL || undefined),
    solveCaptcha: opts.solveCaptcha ?? process.env.STEEL_CAPTCHA === "1",
    // C8: inject stored credentials for an account when a profile record names a competitor for it
    credentialNamespaceFor: (accountRef) => {
      const rec = loadProfiles().find((p) => p.accountRef === accountRef);
      return rec?.credentialNamespace ?? (rec ? credentialNamespace(rec.competitor, rec.accountRef) : undefined);
    },
  });
  const pool = new SessionPool(adapter, {
    // PERISCOPE_MAX_CONCURRENT matches the Steel plan: 10 on Launch, 100 on Scale
    maxConcurrent: Math.max(1, Number(process.env.PERISCOPE_MAX_CONCURRENT ?? 10)),
    homeCountryOf: async (profileId) => loadProfiles().find((p) => p.profileId === profileId)?.homeCountry ?? null,
    // C6: a locally recorded profile must be READY on Steel before reuse; unknown ids are asked live
    isProfileReady: async (profileId) => {
      const rec = loadProfiles().find((p) => p.profileId === profileId);
      if (rec?.ready) return true;
      return adapter.isProfileReady(profileId);
    },
    onDeadline: async (sessionId, lastCheckpoint) => {
      // The coordinator owns job state; here we only log. Jobs read handle.deadlineAt and checkpoint themselves.
      console.warn(`[pool] session ${sessionId} reached its deadline; checkpoint ${lastCheckpoint ? "saved" : "absent"}; releasing`);
    },
  });
  const notifier = new Notifier({ webhookUrl: opts.webhookUrl ?? (process.env.PERISCOPE_WEBHOOK_URL || undefined) });
  const handoff = new HandoffController(opts.driver ?? noopDriver, opts.sink, {
    humanTimeoutMs: process.env.PERISCOPE_HUMAN_TIMEOUT_MS ? Number(process.env.PERISCOPE_HUMAN_TIMEOUT_MS) : undefined,
    notify: (evt, wall) => notifier.notify(evt, wall),
    captchaStatus: (sessionId) => adapter.captchaStatus(sessionId) as Promise<never>,
    signedInIndicator: async (handle) => {
      const rec = handle.profileId ? loadProfiles().find((p) => p.profileId === handle.profileId) : undefined;
      return rec?.signedInIndicator ?? null;
    },
  });
  return {
    steel: adapter.client,
    adapter,
    pool,
    handoff,
    notifier,
    acquireSession: (req) => pool.lease(req),
    reconcile: () => pool.reconcile(),
    onWall: (wall, handle) => handoff.onWall(wall, handle),
    waitForResolution: (jobId) => handoff.waitForResolution(jobId),
    resume: async (jobId, generation) => {
      const r = await handoff.resume(jobId, generation);
      if (r.ok) notifier.stop(jobId);
      return r;
    },
  };
}
