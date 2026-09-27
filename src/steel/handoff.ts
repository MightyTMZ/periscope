// Owner: Fahad. Layer 4: single-driver lock, handoff, resume. Tests: C13 to C17, C21.
//
// Contract: before a human gets the viewer, scheduling stops for the job, the in-flight action
// finishes or times out, pending model proposals are discarded, state becomes awaiting_human.
// Resume needs the right generation, re-observes, and verifies the signed-in indicator.
// Payment walls refuse resume while the field is visible. A 10-minute human timer ends the job as partial.
// CAPTCHA walls try Steel's solver first (when configured) and only escalate on failure, timeout, or unsupported family.

import type { EventSink, HandoffEvent, SessionHandle, WallDetected } from "@periscope/contracts";
import { classifyFromDom, type WallKind } from "./walls.js";
import { waitForSteelSolve, type CaptchaStatus } from "./captcha.js";

export interface JobDriver {
  /** Stop scheduling new actions; resolve when the in-flight action has finished or timed out. */
  pause(jobId: string, timeoutMs: number): Promise<void>;
  /** Drop any model proposal not yet executed. */
  discardPending(jobId: string): void;
  /** Hand control back to the agent. */
  resume(jobId: string): void;
  /** Mark the job partial or failed with a reason. */
  fail(jobId: string, state: "partial" | "failed", reason: string): Promise<void>;
}

export interface HandoffOptions {
  humanTimeoutMs?: number;      // default 10 minutes
  inFlightTimeoutMs?: number;   // default 20 seconds
  /** Text that proves the account is signed in; resolved from the session's profile. */
  signedInIndicator?: (handle: SessionHandle) => Promise<string | null>;
  notify?: (evt: HandoffEvent, wall: WallDetected) => Promise<void>;
  /** Steel solver status for a session. When set, CAPTCHA walls try Steel first and only escalate on failure. */
  captchaStatus?: (sessionId: string) => Promise<CaptchaStatus>;
  captchaWaitMs?: number;       // default 30 seconds
}

interface Pending { wall: WallDetected; handle: SessionHandle; generation: number; timer: NodeJS.Timeout; waiters: Array<(r: "resumed" | "abandoned") => void>; }

export type OnWallResult = HandoffEvent | { jobId: string; state: "solved_by_steel" };

export class HandoffController {
  private pending = new Map<string, Pending>();
  private generations = new Map<string, number>();

  constructor(private readonly driver: JobDriver, private readonly sink: EventSink, private readonly opts: HandoffOptions = {}) {}

  /** Called when B or C raises a wall. CAPTCHAs go to Steel's solver first; a human is only called when Steel fails. */
  async onWall(wall: WallDetected, handle: SessionHandle): Promise<OnWallResult> {
    if (wall.wall === "captcha" && this.opts.captchaStatus) {
      const result = await waitForSteelSolve(
        () => this.opts.captchaStatus!(wall.sessionId),
        () => handle.page.content(),
        { timeoutMs: this.opts.captchaWaitMs ?? 45_000 },
      );
      await this.sink.write({ type: "job_state", data: { jobId: wall.jobId, state: "running", reason: `captcha:${result.outcome}${"reason" in result ? ":" + result.reason : ""}` } });
      if (result.outcome === "solved") return { jobId: wall.jobId, state: "solved_by_steel" };
    }
    await this.driver.pause(wall.jobId, this.opts.inFlightTimeoutMs ?? 20_000);
    this.driver.discardPending(wall.jobId);
    const generation = (this.generations.get(wall.jobId) ?? 0) + 1;
    this.generations.set(wall.jobId, generation);
    const evt: HandoffEvent = { jobId: wall.jobId, viewerUrl: handle.viewerUrl, wall: wall.wall, generation, state: "awaiting_human" };
    const timer = setTimeout(() => void this.abandon(wall.jobId, "human timer expired"), this.opts.humanTimeoutMs ?? 10 * 60 * 1000);
    this.pending.set(wall.jobId, { wall, handle, generation, timer, waiters: [] });
    await this.sink.write({ type: "job_state", data: { jobId: wall.jobId, state: "awaiting_human", reason: wall.wall } });
    await this.sink.write({ type: "handoff", data: evt });
    if (this.opts.notify) await this.opts.notify(evt, wall);
    return evt;
  }

  /** Called from the API when the human says they are done. */
  async resume(jobId: string, generation: number): Promise<{ ok: true } | { ok: false; reason: string }> {
    const p = this.pending.get(jobId);
    if (!p) return { ok: false, reason: "no handoff pending" };
    if (p.generation !== generation) return { ok: false, reason: "stale generation" };
    // Payment and authentication walls require a meaningful post-human check.
    // CAPTCHA/consent pages may retain their challenge markup after the solver
    // or the human has cleared the challenge, so do not reject those on stale DOM.
    if (p.wall.wall === "payment" || p.wall.wall === "login" || p.wall.wall === "2fa" || p.wall.wall === "email_code") {
      const still = await classifyFromDom(p.handle.page);
      if (p.wall.wall === "payment" && still.wall === "payment") return { ok: false, reason: "payment field still visible" };
    }
    if (p.wall.wall === "login" || p.wall.wall === "2fa" || p.wall.wall === "email_code") {
      const indicator = this.opts.signedInIndicator ? await this.opts.signedInIndicator(p.handle) : null;
      if (indicator) {
        const text = await p.handle.page.locator("body").innerText().catch(() => "");
        if (!text.includes(indicator)) return { ok: false, reason: "signed-in indicator not found after resume" };
      }
    }
    clearTimeout(p.timer);
    this.pending.delete(jobId);
    await this.sink.write({ type: "handoff", data: { jobId, viewerUrl: p.handle.viewerUrl, wall: p.wall.wall, generation, state: "resumed" } });
    await this.sink.write({ type: "job_state", data: { jobId, state: "running" } });
    this.driver.resume(jobId);
    for (const w of p.waiters) w("resumed");
    return { ok: true };
  }

  /** Resolves when the human resumes the job or the handoff is abandoned. Resolves "resumed" at once if nothing is pending. */
  waitForResolution(jobId: string): Promise<"resumed" | "abandoned"> {
    const p = this.pending.get(jobId);
    if (!p) return Promise.resolve("resumed");
    return new Promise((resolve) => p.waiters.push(resolve));
  }

  isPending(jobId: string): boolean { return this.pending.has(jobId); }
  async cancel(jobId: string): Promise<void> {
    const p = this.pending.get(jobId);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(jobId);
    await this.sink.write({ type: "handoff", data: { jobId, viewerUrl: p.handle.viewerUrl, wall: p.wall.wall, generation: p.generation, state: "abandoned" } });
    for (const waiter of p.waiters) waiter("abandoned");
  }
  pendingWall(jobId: string): WallKind | undefined { return this.pending.get(jobId)?.wall.wall; }

  async abandon(jobId: string, reason: string): Promise<void> {
    const p = this.pending.get(jobId);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(jobId);
    await this.sink.write({ type: "handoff", data: { jobId, viewerUrl: p.handle.viewerUrl, wall: p.wall.wall, generation: p.generation, state: "abandoned" } });
    await this.driver.fail(jobId, "partial", reason);
    for (const w of p.waiters) w("abandoned");
  }
}
