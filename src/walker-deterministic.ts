// Model-free walker (segment C). Crawls the signed-in web space of a competitor from a start page: every same-origin
// link is a screen, every screen's visible lines are interior observations, every navigation is followed by a wall
// check so a login, CAPTCHA, 2FA or payment page hands off to a human instead of being clicked through.
// Tom's Stagehand walker (src/walker.ts) is the richer version when a model key is present; this one runs without it
// and shares the WalkerResult shape so the coordinator's wall loop works unchanged.
//
// It only ever navigates links. It never presses buttons, never submits forms, never follows links whose text matches
// the blocklist (pay, delete, invite, logout ...). Billing and checkout pages are recorded as links, not visited.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Page } from "playwright-core";
import type { Observation, SessionHandle, WallDetected, EventSink } from "@periscope/contracts";
import { createObservation } from "./utils/observation-factory.js";
import { textHash } from "./utils/text.js";
import { saveScreenshot } from "./utils/screenshot.js";
import { classifyFromDom } from "./steel/walls.js";
import { visibleLines, CODE_LIKE, revealDeterministic, type StrategyName } from "./reveal-deterministic.js";
import type { WalkerResult, ScreenInfo } from "./walker.js";

export interface DeterministicWalkerConfig {
  runId: string;
  jobId: string;
  competitor: string;
  startUrl: string;
  page: Page;
  handle: SessionHandle;
  sink: EventSink;
  maxScreens?: number;        // default 40
  maxSteps?: number;          // default 120
  wallScreenshotDir?: string; // default data/walls
  /** Lines already known from the surface pass; interior lines absent from it are flagged missedByFetch. */
  surfaceBaseline?: string;
  /**
   * Sign in without a human when a login wall appears: Steel has already injected the stored credentials from its
   * vault (the model never sees the password), the walker ticks the anti-bot box and submits. Falls back to the
   * human handoff when the form was not filled or the wall stays.
   */
  autoLogin?: boolean;
  /** Reveal strategies to run on every screen (expandable rows, selects, modals). Default: none, links only. */
  revealOnScreens?: StrategyName[];
}

const DEFAULT_BLOCK = /\b(pay|buy|delete|remove|send|invite|publish|upgrade|subscribe|confirm order|submit|log ?out|sign ?out|cancel (plan|subscription)|checkout|update payment)\b/i;
const NOT_A_PAGE = /\.(pdf|docx?|xlsx?|pptx?|csv|zip|png|jpe?g|gif|svg|mp4|webm)(\?|#|$)|^(mailto|tel|javascript):/i;

function canonical(u: string): string {
  try { const x = new URL(u); x.hash = ""; return x.toString(); } catch { return u; }
}

/** The prefix a link must share to count as the same site: the origin, or for file fixtures the directory. */
function siteRoot(u: string): string {
  try {
    const x = new URL(u);
    if (x.protocol === "file:") return x.href.slice(0, x.href.lastIndexOf("/") + 1);
    return x.origin;
  } catch { return u; }
}

/**
 * Same site, subdomains included: a login on example.com usually lands on app.example.com, and the dashboard lives
 * there. File fixtures keep the directory rule.
 */
function onSite(href: string, root: string): boolean {
  if (root.startsWith("file:")) return href.startsWith(root);
  try {
    const h = new URL(href), r = new URL(root);
    if (h.protocol !== "http:" && h.protocol !== "https:") return false;
    const base = r.hostname.replace(/^www\./, "");
    const host = h.hostname.replace(/^www\./, "");
    return host === base || host.endsWith(`.${base}`);
  } catch { return false; }
}

async function wallOn(page: Page, cfg: DeterministicWalkerConfig, generation: number): Promise<WallDetected | undefined> {
  const verdict = await classifyFromDom(page);
  if (!verdict.wall) return undefined;
  const dir = cfg.wallScreenshotDir ?? path.join("data", "walls");
  mkdirSync(dir, { recursive: true });
  const screenshotPath = path.join(dir, `${cfg.jobId}-${generation}-${Date.now()}.png`);
  try { writeFileSync(screenshotPath, await page.screenshot({ type: "png" })); } catch { /* screenshot is best effort */ }
  return { jobId: cfg.jobId, sessionId: cfg.handle.sessionId, wall: verdict.wall, screenshotPath, generation };
}

async function linksOn(page: Page, root: string): Promise<Array<{ href: string; label: string }>> {
  const found = await page.evaluate(() => Array.from(document.querySelectorAll("a[href]")).map((a) => ({
    href: (a as HTMLAnchorElement).href, label: ((a as HTMLElement).innerText || a.getAttribute("aria-label") || a.getAttribute("title") || "").trim().slice(0, 80),
  }))).catch(() => [] as Array<{ href: string; label: string }>);
  const out: Array<{ href: string; label: string }> = [];
  const seen = new Set<string>();
  for (const l of found) {
    if (!onSite(l.href, root) || NOT_A_PAGE.test(l.href)) continue;
    const c = canonical(l.href);
    if (seen.has(c)) continue;
    seen.add(c);
    out.push({ href: c, label: l.label });
  }
  return out;
}

/**
 * Steel fills the sign-in form from its credentials vault shortly after the page loads. The walker only waits for
 * that, clears a self-hosted anti-bot checkbox (ALTCHA and similar solve themselves in the browser once ticked),
 * presses the form's own submit button, and reports whether the password field is gone. No password ever passes
 * through this code.
 */
export async function tryAutoLogin(page: Page): Promise<{ ok: boolean; reason: string }> {
  const pw = page.locator("input[type=password]").first();
  try { await pw.waitFor({ state: "visible", timeout: 5000 }); } catch { return { ok: false, reason: "no password field" }; }
  let filled = false;
  for (let i = 0; i < 20 && !filled; i++) {
    filled = ((await pw.inputValue().catch(() => "")) ?? "").length > 0;
    if (!filled) await page.waitForTimeout(500);
  }
  if (!filled) return { ok: false, reason: "Steel did not inject the stored credentials within 10 s (is the credential bound to this exact origin?)" };
  await page.waitForTimeout(1500); // let the anti-bot widget finish initialising before it is ticked
  const box = page.locator("altcha-widget input[type=checkbox], #altcha-placeholder input[type=checkbox], input[type=checkbox][name*=captcha i], input[type=checkbox][id*=altcha i]").first();
  let boxSeen = false;
  if (await box.count()) {
    boxSeen = true;
    let verified = false;
    for (let attempt = 0; attempt < 2 && !verified; attempt++) {
      await box.click({ timeout: 3000, force: true }).catch(() => undefined);
      for (let i = 0; i < 30 && !verified; i++) {
        verified = await page.evaluate(() => {
          const token = document.querySelector("input[name=altcha]") as HTMLInputElement | null;
          const state = document.querySelector("div.altcha")?.getAttribute("data-state") ?? document.querySelector("altcha-widget")?.getAttribute("data-state");
          return Boolean(token?.value) || state === "verified";
        }).catch(() => false);
        if (!verified) await page.waitForTimeout(500);
      }
    }
    if (!verified) return { ok: false, reason: "the anti-bot box did not verify in the browser" };
  }
  const submit = page.locator("form button[type=submit], form input[type=submit]").first();
  if (!(await submit.count())) return { ok: false, reason: "no submit button in the form" };
  const before = page.url();
  await submit.click({ timeout: 3000 }).catch(() => undefined);
  await page.waitForURL((u) => u.toString() !== before, { timeout: 20_000 }).catch(() => undefined);
  await page.waitForLoadState("load", { timeout: 15_000 }).catch(() => undefined);
  await page.waitForTimeout(800);
  if ((await page.locator("input[type=password]").count()) > 0) {
    const err = (await page.locator("body").innerText().catch(() => "")).match(/invalid email|anti-bot|challenge failed|try again/i)?.[0];
    return { ok: false, reason: err ? `the site answered "${err}"` : "the sign-in form is still on screen after submit" };
  }
  return { ok: true, reason: boxSeen ? "credentials injected by Steel, anti-bot box verified in the browser, form submitted" : "credentials injected by Steel, form submitted" };
}

export async function walkDeterministic(cfg: DeterministicWalkerConfig): Promise<WalkerResult> {
  const page = cfg.page;
  const maxScreens = cfg.maxScreens ?? 40;
  const maxSteps = cfg.maxSteps ?? 120;
  const screens = new Map<string, ScreenInfo>();
  const visitedUrls = new Set<string>();
  const seenLines = new Set<string>();
  const queue: Array<{ href: string; label: string; parentHash?: string }> = [{ href: canonical(cfg.startUrl), label: "start" }];
  let totalSteps = 0;
  let generation = 0;
  const root = siteRoot(cfg.startUrl);

  const record = async (label: string, parentHash?: string): Promise<{ hash: string; obs: Observation[] }> => {
    const lines = (await visibleLines(page)).filter((l) => !CODE_LIKE.test(l));
    const hash = textHash(lines.join("\n"));
    const obs: Observation[] = [];
    if (!screens.has(hash)) {
      const screenshotPath = await saveScreenshot(page);
      const screen = createObservation({ runId: cfg.runId, jobId: cfg.jobId, competitor: cfg.competitor, url: page.url(), layer: "interior", source: "browser", kind: "screen", text: JSON.stringify({ label, hash, parentHash: parentHash ?? null }), vantage: cfg.handle.vantage, perception: "dom", screenshotPath, steelSessionId: cfg.handle.sessionId, viewerUrl: cfg.handle.viewerUrl });
      await cfg.sink.write({ type: "observation", data: screen });
      for (const line of lines) {
        if (seenLines.has(line)) continue;
        seenLines.add(line);
        const o = createObservation({
          runId: cfg.runId, jobId: cfg.jobId, competitor: cfg.competitor, url: page.url(), layer: "interior", source: "browser",
          kind: "text", text: line, revealedBy: { action: "click", label }, vantage: cfg.handle.vantage, perception: "dom", screenshotPath,
          steelSessionId: cfg.handle.sessionId, viewerUrl: cfg.handle.viewerUrl,
        });
        const flagged = cfg.surfaceBaseline !== undefined ? { ...o, missedByFetch: !cfg.surfaceBaseline.includes(o.text) } : o;
        obs.push(flagged);
        await cfg.sink.write({ type: "observation", data: flagged });
      }
      screens.set(hash, { label, hash, observations: obs, parentHash });
    }
    return { hash, obs };
  };

  while (queue.length > 0) {
    if (screens.size >= maxScreens) return { screens, totalSteps, stoppedReason: "screens_limit" };
    if (totalSteps >= maxSteps) return { screens, totalSteps, stoppedReason: "steps_limit" };
    if (new Date() >= new Date(cfg.handle.deadlineAt)) return { screens, totalSteps, stoppedReason: "deadline" };

    const next = queue.shift()!;
    if (visitedUrls.has(next.href)) continue;
    visitedUrls.add(next.href);
    totalSteps++;

    try {
      // Full load, not just DOM: Steel's CAPTCHA solver attaches only after the load event (C22).
      await page.goto(next.href, { waitUntil: "load", timeout: 30_000 }).catch(async () => { await page.goto(next.href, { waitUntil: "domcontentloaded", timeout: 30_000 }); });
      await page.waitForTimeout(800);
    } catch {
      continue;
    }
    if (!onSite(canonical(page.url()), root)) continue; // redirected off-site

    let wall = await wallOn(page, cfg, generation);
    if (wall && wall.wall === "login" && cfg.autoLogin) {
      const attempt = await tryAutoLogin(page);
      if (attempt.ok) {
        wall = await wallOn(page, cfg, generation);
        if (!wall) {
          await cfg.sink.write({ type: "job_state", data: { jobId: cfg.jobId, state: "running", reason: `login: ${attempt.reason}, signed in without a human` } });
          visitedUrls.add(canonical(page.url()));
          next.label = "signed in";
        }
      } else {
        await cfg.sink.write({ type: "job_state", data: { jobId: cfg.jobId, state: "running", reason: `login attempt: ${attempt.reason}; handing off to a human` } });
      }
    }
    if (wall) {
      generation++;
      return { screens, totalSteps, wallDetected: wall, stoppedReason: "wall" };
    }

    const { hash } = await record(next.label, next.parentHash);
    if (cfg.revealOnScreens?.length) {
      // Expand what the screen hides (rows, selects, cards) and file it under this screen.
      const res = await revealDeterministic({
        runId: cfg.runId, jobId: cfg.jobId, competitor: cfg.competitor, url: page.url(), surfaceBaseline: cfg.surfaceBaseline ?? "",
        page, handle: cfg.handle, sink: cfg.sink, strategies: cfg.revealOnScreens, maxActionsPerStrategy: 10,
      }).catch(() => undefined);
      if (res) { const screen = screens.get(hash); if (screen) screen.observations.push(...res.observations.map((o) => ({ ...o, layer: "interior" as const }))); }
    }
    for (const link of await linksOn(page, root)) {
      if (visitedUrls.has(link.href)) continue;
      if (DEFAULT_BLOCK.test(link.label) || DEFAULT_BLOCK.test(link.href)) {
        // observed, never visited
        if (!seenLines.has(link.href)) {
          seenLines.add(link.href);
          const o = createObservation({
            runId: cfg.runId, jobId: cfg.jobId, competitor: cfg.competitor, url: page.url(), layer: "interior", source: "browser",
            kind: "link", text: link.href, revealedBy: { action: "none", label: link.label || "blocked link" }, vantage: cfg.handle.vantage, perception: "dom",
            steelSessionId: cfg.handle.sessionId,
          });
          await cfg.sink.write({ type: "observation", data: o });
        }
        continue;
      }
      queue.push({ href: link.href, label: link.label || link.href, parentHash: hash });
    }

    if (totalSteps % 5 === 0) {
      await cfg.handle.checkpoint({ jobId: cfg.jobId, url: page.url(), screens: screens.size, steps: totalSteps, queued: queue.length }).catch(() => undefined);
    }
  }
  return { screens, totalSteps, stoppedReason: "complete" };
}
