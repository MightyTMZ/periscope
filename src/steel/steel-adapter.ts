// Owner: Fahad. Layer 1. The only file that talks to the Steel SDK directly.
// Spec: docs/periscope-final-architecture.md, section 7.1. Tests: C1, C3, C4, C5, C8, C11, C19, C22.
//
// Verified against steel-sdk 0.18.0 types and live on Sept 13: sessions.create accepts timeout, solveCaptcha,
// profileId, persistProfile, deviceConfig.device, useProxy.geolocation, namespace, credentials.
// CAPTCHA solving and managed proxies need a $10 paid balance on the Launch plan (403 otherwise).

import Steel from "steel-sdk";
import { chromium } from "playwright-core";
import type { LeaseRequest, SessionHandle, Vantage } from "@periscope/contracts";

const SESSION_TIMEOUT_MS = 14 * 60 * 1000;   // free plan cap is 15 minutes
const AUTONOMOUS_CUTOFF_MS = 11 * 60 * 1000; // deadlineAt: work stops here, 3 minutes reserved for handoff and collection
/** Chrome writes its cookie jar to disk lazily (about every 30 s). A profile snapshot taken before that flush has
 *  localStorage but no cookies (observed Sept 13). Wait at least this long after the last login step before release. */
export const PROFILE_SETTLE_MS = 40_000;

export interface SteelAdapterOptions {
  apiKey: string;
  proxyUrl?: string;          // bring-your-own proxy when managed proxies are not unlocked
  solveCaptcha?: boolean;     // Steel's solver needs a $10 paid balance on Launch; default off. Set STEEL_CAPTCHA=1 to enable
  /** Credentials namespace to inject for a lease's accountRef; return undefined for no injection. */
  credentialNamespaceFor?: (accountRef: string) => string | undefined;
  onCheckpoint?: (sessionId: string, state: unknown) => Promise<void>;
  /** Steel extension ids to install for a lease (Stagehand's runtime when a model will drive the session). */
  extensionIdsFor?: (req: LeaseRequest) => Promise<string[]>;
}

export type ProfileStatus = "UPLOADING" | "READY" | "FAILED" | "UNKNOWN";

export interface TraceEvent { type: string; timestamp: string; endTimestamp?: string; page?: { url?: string }; [k: string]: unknown }
export interface TraceExport { sessionId: string; events: TraceEvent[]; total: number; hasMore: boolean; complete: boolean; fetchedAt: string }

export class SteelAdapter {
  private readonly steel: Steel;

  constructor(private readonly opts: SteelAdapterOptions) {
    if (!opts.apiKey) throw new Error("STEEL_API_KEY is required");
    this.steel = new Steel({ steelAPIKey: opts.apiKey });
  }

  /** The underlying Steel client, for callers that need raw SDK access (Person B's surface pass). */
  get client(): Steel { return this.steel; }

  /** Create a session for a lease and attach Playwright over CDP. */
  async open(req: LeaseRequest): Promise<SessionHandle> {
    const createOpts: Record<string, unknown> = { timeout: SESSION_TIMEOUT_MS };
    if (this.opts.solveCaptcha ?? process.env.STEEL_CAPTCHA === "1") createOpts.solveCaptcha = true;
    if (req.profileId) createOpts.profileId = req.profileId;
    if (req.purpose === "setup" || req.purpose === "walker") createOpts.persistProfile = true;
    if (req.vantage.device === "mobile") createOpts.deviceConfig = { device: "mobile" };
    if (req.vantage.country) {
      createOpts.useProxy = this.opts.proxyUrl
        ? { url: this.opts.proxyUrl }
        : { geolocation: { country: req.vantage.country, ...(req.vantage.region ? { state: req.vantage.region } : {}) } };
    }
    // C8: credential injection. Steel types the password itself; the model never sees it.
    const ns = req.accountRef ? this.opts.credentialNamespaceFor?.(req.accountRef) : undefined;
    if (ns) {
      createOpts.namespace = ns;
      // blurFields off: Steel's blur overlay swallowed clicks on the page's anti-bot checkbox (Sept 13, ALTCHA on Helix); the field is type=password anyway
      createOpts.credentials = { autoSubmit: false, blurFields: false, exactOrigin: true };
    }

    const extensionIds = this.opts.extensionIdsFor ? await this.opts.extensionIdsFor(req) : [];
    if (extensionIds.length) createOpts.extensionIds = extensionIds;

    // The plan's concurrent-session limit answers 429. A job that meets it waits for a slot instead of failing, so a
    // whole-site run of 60 jobs flows through 10 browsers in waves rather than losing pages.
    const session = await createSessionWithRetry(() => this.steel.sessions.create(createOpts as never));
    const query = new URLSearchParams({ apiKey: this.opts.apiKey, sessionId: session.id });
    const cdpUrl = `wss://connect.steel.dev?${query.toString()}`; // never log this: it carries the API key
    const browser = await chromium.connectOverCDP(cdpUrl);
    const context = browser.contexts()[0];
    if (!context) throw new Error("Steel browser context unavailable");
    const page = context.pages()[0] ?? (await context.newPage());

    const deadlineAt = new Date(Date.now() + AUTONOMOUS_CUTOFF_MS).toISOString();
    const steel = this.steel;
    const onCheckpoint = this.opts.onCheckpoint;

    return {
      sessionId: session.id,
      viewerUrl: (session as { sessionViewerUrl?: string }).sessionViewerUrl ?? "",
      cdpUrl,
      vantage: req.vantage,
      // C5: Steel assigns the profile id at create time when persistProfile is set; it becomes READY after release.
      profileId: (session as { profileId?: string }).profileId ?? req.profileId,
      page,
      deadlineAt,
      async checkpoint(state) {
        if (onCheckpoint) await onCheckpoint(session.id, state);
      },
      async release() {
        try { await browser.close(); } catch { /* already closed */ }
        await steel.sessions.release(session.id);
      },
    };
  }

  /* ---------------- profiles (C5, C6) ---------------- */

  async profileStatus(profileId: string): Promise<ProfileStatus> {
    try {
      const p = await this.steel.profiles.get(profileId);
      return ((p as { status?: ProfileStatus }).status ?? "UNKNOWN");
    } catch {
      return "UNKNOWN";
    }
  }

  async isProfileReady(profileId: string): Promise<boolean> {
    return (await this.profileStatus(profileId)) === "READY";
  }

  /* ---------------- sessions (C11) ---------------- */

  /** Ids of sessions currently live on the account. Used only to reconcile the ones this app owns. */
  async liveSessionIds(): Promise<string[]> {
    const ids: string[] = [];
    for await (const s of this.steel.sessions.list({ status: "live" })) ids.push(s.id);
    return ids;
  }

  async releaseSession(sessionId: string): Promise<void> {
    await this.steel.sessions.release(sessionId);
  }

  /* ---------------- credentials (C8) ---------------- */

  /** Store a credential through Steel. The value is passed straight to Steel and never logged or kept. */
  async storeCredential(input: { namespace: string; origin: string; username: string; password: string; totpSecret?: string; label?: string }): Promise<void> {
    const value: Record<string, string> = { username: input.username, password: input.password };
    if (input.totpSecret) value.totpSecret = input.totpSecret;
    await this.steel.credentials.create({ origin: input.origin, namespace: input.namespace, label: input.label, value });
  }

  async listCredentials(namespace?: string): Promise<Array<{ origin?: string; namespace?: string; label?: string }>> {
    const r = (await this.steel.credentials.list(namespace ? { namespace } : {})) as unknown as { credentials?: Array<{ origin?: string; namespace?: string; label?: string }> } | Array<{ origin?: string }>;
    return Array.isArray(r) ? r : (r.credentials ?? []);
  }

  async deleteCredential(origin: string, namespace?: string): Promise<void> {
    await this.steel.credentials.delete({ origin, namespace });
  }

  /* ---------------- CAPTCHA (C21, C22) ---------------- */

  /**
   * Steel's CAPTCHA solver status for a session. Polled; Steel sends no events.
   * Live shape (Sept 13): an array of page states [{ pageId, url, isSolvingCaptcha, tasks: [{ type, status, ... }] }];
   * before any page is tracked it can be [] or { states: [] }. Detection attaches on full page load, so
   * navigate with waitUntil "load" before expecting tasks.
   */
  async captchaStatus(sessionId: string): Promise<{ isSolvingCaptcha: boolean; tasks: Array<{ type?: string; status: string }> }> {
    const raw = (await this.steel.sessions.captchas.status(sessionId)) as unknown;
    type PageState = { isSolvingCaptcha?: boolean; tasks?: Array<{ type?: string; status: string }> };
    const pages: PageState[] = Array.isArray(raw)
      ? (raw as PageState[])
      : ((raw as { states?: PageState[]; pages?: PageState[] }).states ?? (raw as { pages?: PageState[] }).pages ?? []);
    return {
      isSolvingCaptcha: pages.some((pg) => Boolean(pg.isSolvingCaptcha)),
      tasks: pages.flatMap((pg) => pg.tasks ?? []),
    };
  }

  /** Ask Steel to (re)try solving every CAPTCHA it has detected on the session. */
  async triggerCaptchaSolve(sessionId: string): Promise<unknown> {
    return this.steel.sessions.captchas.solve(sessionId, {});
  }

  /* ---------------- evidence: traces and files (C19) ---------------- */

  /** Agent trace export. Raw REST, no SDK method. Incomplete coverage is marked, never hidden. */
  async exportTrace(sessionId: string, range?: { start?: string; end?: string }): Promise<TraceExport> {
    const q = new URLSearchParams();
    if (range?.start) q.set("startTime", range.start);
    if (range?.end) q.set("endTime", range.end);
    const url = `https://api.steel.dev/v1/sessions/${sessionId}/agent-traces${q.size ? "?" + q.toString() : ""}`;
    const res = await fetch(url, { headers: { "steel-api-key": this.opts.apiKey } });
    if (!res.ok) throw new Error(`agent-traces ${res.status}`);
    const body = (await res.json()) as { events?: TraceEvent[]; total?: number; hasMore?: boolean };
    const events = body.events ?? [];
    return { sessionId, events, total: body.total ?? events.length, hasMore: Boolean(body.hasMore), complete: !body.hasMore, fetchedAt: new Date().toISOString() };
  }

  /** Files the browser saved during the session. */
  async listFiles(sessionId: string): Promise<Array<{ path: string; size?: number }>> {
    const r = (await this.steel.sessions.files.list(sessionId)) as unknown as { data?: Array<{ path: string; size?: number }>; files?: Array<{ path: string; size?: number }> } | Array<{ path: string; size?: number }>;
    return Array.isArray(r) ? r : (r.data ?? r.files ?? []);
  }

  /** Download every session file as one zip (bytes). */
  async downloadArchive(sessionId: string): Promise<Uint8Array> {
    const res = await this.steel.sessions.files.downloadArchive(sessionId);
    return new Uint8Array(await res.arrayBuffer());
  }

  async downloadFile(sessionId: string, path: string): Promise<Uint8Array> {
    const res = await this.steel.sessions.files.download(sessionId, path);
    return new Uint8Array(await res.arrayBuffer());
  }

  /* ---------------- vantage check (C3) ---------------- */

  static async detectedIp(handle: SessionHandle): Promise<{ ip: string; country?: string }> {
    await handle.page.goto("https://ipinfo.io/json", { waitUntil: "domcontentloaded" });
    const text = await handle.page.locator("body").innerText();
    const json = JSON.parse(text) as { ip: string; country?: string };
    return { ip: json.ip, country: json.country };
  }
}

export function defaultVantage(overrides: Partial<Vantage> = {}): Vantage {
  return { country: null, device: "desktop", authenticated: false, ...overrides };
}

async function createSessionWithRetry<T>(create: () => Promise<T>): Promise<T> {
  let delay = 5_000;
  const started = Date.now();
  for (let attempt = 1; ; attempt++) {
    try {
      return await create();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const limit = /429|concurrent session limit|too many/i.test(msg);
      if (!limit || Date.now() - started > 4 * 60_000) throw err;
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(Math.round(delay * 1.5), 30_000);
    }
  }
}
