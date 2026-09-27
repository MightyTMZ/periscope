// Deterministic reveal pass: plain Playwright, no model calls. Runs first; Tom's Stagehand reveal is the fallback
// for layouts these rules do not recognise. Spec: docs/periscope-final-architecture.md, section 6.3.
//
// After every action the visible text is diffed against the baseline and everything captured so far; new blocks
// become observations with revealedBy set and missedByFetch computed against the surface baseline.
// URL-change guard: a control that navigates is recorded as a `link` and the page is restored.
// Blocklist: never clicks a control whose label matches fixtures/blocklist.json.

import { readFileSync } from "node:fs";
import type { Page, Locator } from "playwright-core";
import type { Observation, SessionHandle, EventSink } from "@periscope/contracts";
import { createObservation, markMissedByFetch } from "./utils/observation-factory.js";
import { normalizeText, splitBlocks } from "./utils/text.js";
import { saveScreenshot } from "./utils/screenshot.js";

/** Visible text as normalized lines. innerText preserves the line structure the diff needs. */
export async function visibleLines(page: Page): Promise<string[]> {
  const raw = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
  return raw.split(/\r?\n/).map(normalizeText).filter((l) => l.length >= 3 && readsAsText(l));
}

/** ASCII-art backgrounds and decorative glyph rows are not content: keep lines that are mostly letters and digits. */
export function readsAsText(line: string): boolean {
  const alnum = (line.match(/[\p{L}\p{N}]/gu) ?? []).length;
  if (alnum / line.length < 0.4) return false;
  // glyph rows made of x, s and # pass the ratio test; real words carry a vowel or a digit
  return /\d|[\p{L}]*[aeiouyäöüéèàáíóú][\p{L}]{2,}|[\p{L}]{2,}[aeiouyäöüéèàáíóú][\p{L}]*/iu.test(line);
}

/** Site navigation labels: opening these reveals a menu, not product content. */
const NAV_LABEL = /^(platform|products?|solutions?|resources|company|developers?|docs|documentation|pricing|use cases|learn|more|about|community|customers|blog|support|features|integrations)$/i;

/** Third-party widgets embedded on the page; their text is about the widget, not the competitor. */
const THIRD_PARTY_IFRAME = /bugherd|intercom|hubspot|drift\.com|crisp\.chat|zendesk|hotjar|cookiebot|onetrust|googletagmanager|doubleclick|stripe\.com|recaptcha|hcaptcha|youtube|vimeo|calendly|typeform/i;

export const CODE_LIKE = /\bvar\s|\bfunction\s*\(|=>|;\s*$|^\/\/|\{\s*$|\}\s*$|window\.|document\./;

export interface DeterministicRevealConfig {
  runId: string;
  jobId: string;
  competitor: string;
  url: string;
  surfaceBaseline: string;
  page: Page;
  handle: SessionHandle;
  sink: EventSink;
  maxActionsPerStrategy?: number;   // default 12
  maxMsPerPage?: number;            // default 180 s: a page never eats the whole session
  blocklistPath?: string;           // default fixtures/blocklist.json
  /** Subset of strategies to run, in this order. Default: all. Borders uses a light set. */
  strategies?: StrategyName[];
  /** Emit the baseline visible lines as observations under this layer (borders needs per-vantage rows). */
  emitBaselineAs?: "borders" | "hidden";
}

export type StrategyName = "consent" | "menus" | "tabs" | "selects" | "toggles" | "showMore" | "hover" | "modals" | "iframes" | "documents" | "hiddenApi" | "sweep";
export const LIGHT_STRATEGIES: StrategyName[] = ["consent", "toggles", "selects", "documents", "hiddenApi"];

export interface DeterministicRevealResult {
  observations: Observation[];
  /** Every link on the rendered page (absolute urls). Whole-site runs feed these back into the map. */
  links: string[];
  missedByFetch: number;
  actions: number;
  strategies: Record<string, number>;   // observations produced per strategy
}

interface Ctx {
  cfg: DeterministicRevealConfig;
  baseline: string;
  seen: Set<string>;
  observations: Observation[];
  actions: number;
  max: number;
  blocked: RegExp;
  strategies: Record<string, number>;
  apiUrls: Set<string>;
  deadline: number;
}

function loadBlocklist(path: string): RegExp {
  try {
    const j = JSON.parse(readFileSync(path, "utf8")) as { blockedClickLabels?: string[] };
    const labels = (j.blockedClickLabels ?? []).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    return new RegExp(`\\b(${labels.join("|")})\\b`, "i");
  } catch {
    return /\b(pay|buy|delete|remove|send|invite|publish|upgrade|subscribe|confirm order|submit)\b/i;
  }
}

async function emit(ctx: Ctx, obs: Observation): Promise<void> {
  ctx.observations.push(obs);
  await ctx.cfg.sink.write({ type: "observation", data: obs });
}

async function capture(ctx: Ctx, strategy: string, revealedBy: Observation["revealedBy"]): Promise<number> {
  const lines = await visibleLines(ctx.cfg.page);
  const blocks: string[] = [];
  for (const line of lines) {
    if (ctx.seen.has(line)) continue;
    ctx.seen.add(line);
    blocks.push(line);
  }
  let n = 0;
  const screenshotPath = blocks.length ? await saveScreenshot(ctx.cfg.page) : undefined;
  for (const block of blocks) {
    if (block.length < 3 || CODE_LIKE.test(block)) continue;
    let obs = createObservation({
      runId: ctx.cfg.runId, jobId: ctx.cfg.jobId, competitor: ctx.cfg.competitor, url: ctx.cfg.url,
      layer: "hidden", source: "browser", kind: "text", text: block, revealedBy, screenshotPath,
      vantage: ctx.cfg.handle.vantage, perception: "dom", steelSessionId: ctx.cfg.handle.sessionId, viewerUrl: ctx.cfg.handle.viewerUrl,
    });
    obs = markMissedByFetch(obs, ctx.cfg.surfaceBaseline);
    await emit(ctx, obs);
    n++;
  }
  ctx.strategies[strategy] = (ctx.strategies[strategy] ?? 0) + n;
  await documents(ctx, revealedBy?.label);
  return n;
}

/** Click with the URL guard. Returns false if the click navigated (recorded as a link and restored). */
async function guardedClick(ctx: Ctx, target: Locator, label: string): Promise<boolean> {
  if (ctx.actions >= ctx.max * 12 || Date.now() > ctx.deadline) return false;
  if (ctx.blocked.test(label) || /dev ?tools|next\.js/i.test(label)) return false; // never the framework's dev overlay
  const page = ctx.cfg.page;
  const before = page.url();
  try {
    await target.click({ timeout: 4000 });
  } catch {
    return false;
  }
  ctx.actions++;
  await page.waitForTimeout(400);
  const after = page.url();
  if (after !== before) {
    const obs = createObservation({
      runId: ctx.cfg.runId, jobId: ctx.cfg.jobId, competitor: ctx.cfg.competitor, url: ctx.cfg.url,
      layer: "hidden", source: "browser", kind: "link", text: after, revealedBy: { action: "click", label },
      vantage: ctx.cfg.handle.vantage, perception: "dom", steelSessionId: ctx.cfg.handle.sessionId,
    });
    await emit(ctx, obs);
    await page.goto(before, { waitUntil: "domcontentloaded" }).catch(() => undefined);
    await page.waitForTimeout(500);
    return false;
  }
  return true;
}

async function labelOf(l: Locator): Promise<string> {
  const t = (await l.innerText().catch(() => "")) || (await l.getAttribute("aria-label").catch(() => "")) || "";
  return normalizeText(t).slice(0, 80);
}

/* ---------------- strategies ---------------- */

async function consentWalls(ctx: Ctx): Promise<void> {
  const page = ctx.cfg.page;
  const decline = page.locator("button, a, [role=button]").filter({ hasText: /reject|decline|necessary only|essential only|only necessary|deny|ablehnen|nur notwendige|nur erforderliche|refuser|rechazar|rifiuta|weigeren/i }).first();
  if (await decline.count()) {
    const label = await labelOf(decline);
    await guardedClick(ctx, decline, label);
    await capture(ctx, "consent", { action: "click", label });
  }
}

async function tabsAndAccordions(ctx: Ctx): Promise<void> {
  const page = ctx.cfg.page;
  const selectors = [
    "[role=tab]",
    "[aria-expanded=false]",
    "details:not([open]) > summary",
    "[data-tab], [data-toggle=tab], .tab, .tabs button, .accordion-header, .accordion button, .faq-question",
  ];
  // Text-only tab bars (e.g. Framer) expose no roles: fall back to short clickable headings that share a container.
  const candidates = page.locator(selectors.join(", "));
  let count = Math.min(await candidates.count(), ctx.max);
  for (let i = 0; i < count; i++) {
    const el = candidates.nth(i);
    const label = await labelOf(el);
    if (!label) continue;
    // Site navigation menus (Platform, Solutions, Resources ...) open on click too, but a menu is not hidden
    // content about the product; counting it would inflate the missed-by-fetch number.
    const inNav = await el.evaluate((e) => Boolean(e.closest("nav, header, [role=navigation], [role=menubar]"))).catch(() => false);
    if (inNav || NAV_LABEL.test(label)) continue;
    if (await guardedClick(ctx, el, label)) await capture(ctx, "tabs", { action: "click", label });
  }
  // Hand-rolled accordions: a button whose label ends in a plus or minus sign (FAQ lists, "Compare plans +").
  const plus = page.locator("button, [role=button]").filter({ hasText: /[+\-−▾▸]\s*$/ });
  const pn = Math.min(await plus.count(), ctx.max);
  for (let i = 0; i < pn; i++) {
    const el = plus.nth(i);
    const label = await labelOf(el);
    if (!label || NAV_LABEL.test(label)) continue;
    const inNav = await el.evaluate((e) => Boolean(e.closest("nav, header, [role=navigation]"))).catch(() => false);
    if (inNav) continue;
    if (await guardedClick(ctx, el, label)) { count++; await capture(ctx, "tabs", { action: "click", label }); }
  }
  if (count === 0) {
    // Framer-style tabs: short clickable text nodes with cursor:pointer and no link/button role.
    // One evaluate marks the candidates so the remote CDP round trips stay at one per click, not one per element.
    const candidatesFound: Array<{ idx: number; label: string }> = await page.evaluate((max) => {
      const out: Array<{ idx: number; label: string }> = [];
      const seen = new Set<string>();
      const els = Array.from(document.querySelectorAll("div, p, span, h4, h5, h6, li"));
      let idx = 0;
      for (const e of els) {
        if (out.length >= max) break;
        const el = e as HTMLElement;
        if (el.closest("a, button, [role=button], nav, header, footer")) continue;
        const text = (el.innerText || "").trim();
        if (text.length < 2 || text.length > 40 || /\n/.test(text)) continue;
        if (el.children.length > 2) continue;
        const cs = getComputedStyle(el);
        if (cs.cursor !== "pointer" || cs.display === "none" || cs.visibility === "hidden") continue;
        const r = el.getBoundingClientRect();
        if (r.width < 8 || r.height < 8) continue;
        if (seen.has(text)) continue;
        seen.add(text);
        el.setAttribute("data-periscope-tab", String(idx));
        out.push({ idx, label: text });
        idx++;
      }
      return out;
    }, ctx.max).catch(() => [] as Array<{ idx: number; label: string }>);
    for (const cand of candidatesFound) {
      if (ctx.blocked.test(cand.label)) continue;
      const el = page.locator(`[data-periscope-tab="${cand.idx}"]`).first();
      if (await guardedClick(ctx, el, cand.label)) await capture(ctx, "tabs", { action: "click", label: cand.label });
    }
  }
}

async function selects(ctx: Ctx): Promise<void> {
  const page = ctx.cfg.page;
  const all = page.locator("select");
  const n = Math.min(await all.count(), ctx.max);
  for (let i = 0; i < n; i++) {
    const sel = all.nth(i);
    const label = (await sel.getAttribute("name").catch(() => null)) || (await sel.getAttribute("aria-label").catch(() => null)) || `select ${i + 1}`;
    const options = await sel.locator("option").allInnerTexts().catch(() => [] as string[]);
    for (const opt of options.map(normalizeText).filter(Boolean)) {
      let obs = createObservation({
        runId: ctx.cfg.runId, jobId: ctx.cfg.jobId, competitor: ctx.cfg.competitor, url: ctx.cfg.url,
        layer: "hidden", source: "browser", kind: "option", text: `${label}: ${opt}`, revealedBy: { action: "select", label },
        vantage: ctx.cfg.handle.vantage, perception: "dom", steelSessionId: ctx.cfg.handle.sessionId,
      });
      obs = markMissedByFetch(obs, ctx.cfg.surfaceBaseline);
      if (!ctx.seen.has(obs.text)) { ctx.seen.add(obs.text); await emit(ctx, obs); ctx.strategies.selects = (ctx.strategies.selects ?? 0) + 1; }
    }
    // Choosing an option often reveals text ("Volume pricing from ..."): select each one, capture, then restore.
    const values = await sel.locator("option").evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value)).catch(() => [] as string[]);
    const initial = await sel.inputValue().catch(() => values[0]);
    for (const v of values.slice(0, 8)) {
      if (v === initial || ctx.blocked.test(v)) continue;
      try { await sel.selectOption(v, { timeout: 2000 }); ctx.actions++; } catch { continue; }
      await page.waitForTimeout(350);
      await capture(ctx, "selects", { action: "select", label: `${label}: ${v}` });
    }
    if (initial !== undefined) await sel.selectOption(initial, { timeout: 2000 }).catch(() => undefined);
  }
}

async function toggles(ctx: Ctx): Promise<void> {
  const page = ctx.cfg.page;
  const t = page.locator("[role=switch], input[type=checkbox]:visible, [role=radiogroup] [role=radio], label:has(input[type=radio])").filter({ hasNotText: /cookie/i });
  const n = Math.min(await t.count(), ctx.max);
  for (let i = 0; i < n; i++) {
    const el = t.nth(i);
    const label = (await labelOf(el)) || `toggle ${i + 1}`;
    if (await guardedClick(ctx, el, label)) {
      await capture(ctx, "toggles", { action: "toggle", label });
      await guardedClick(ctx, el, label); // restore
    }
  }
  // Pill switches: a button with no text (a knob) next to labels like "Monthly ... Annual".
  const pills = page.locator("button").filter({ hasNotText: /\S/ });
  const pc = Math.min(await pills.count(), 6);
  for (let i = 0; i < pc; i++) {
    const el = pills.nth(i);
    const box = await el.boundingBox().catch(() => null);
    if (!box || box.width > 120 || box.height > 60 || box.width < 20) continue;
    const around = normalizeText(await el.evaluate((e) => (e.parentElement?.innerText ?? "")).catch(() => "")).slice(0, 40);
    if (ctx.blocked.test(around) || /cookie/i.test(around)) continue;
    const label = around ? `switch: ${around}` : `switch ${i + 1}`;
    if (await guardedClick(ctx, el, label)) {
      await capture(ctx, "toggles", { action: "toggle", label });
      await guardedClick(ctx, el, label); // restore
    }
  }
  // Text toggles like "Monthly | Annual" rendered as buttons
  const period = page.locator("button, [role=button], a").filter({ hasText: /^(annual(ly)?|yearly|monthly|per year|per month)$/i });
  const pn = Math.min(await period.count(), 4);
  for (let i = 0; i < pn; i++) {
    const el = period.nth(i); const label = await labelOf(el);
    if (await guardedClick(ctx, el, label)) await capture(ctx, "toggles", { action: "toggle", label });
  }
}

async function showMore(ctx: Ctx): Promise<void> {
  const page = ctx.cfg.page;
  for (let round = 0; round < ctx.max; round++) {
    const btn = page.locator("button, a, [role=button]").filter({ hasText: /^(show|load|see|view|read|expand) (more|all|details)|^expand all$|^read more$|more\b/i }).first();
    if (!(await btn.count())) break;
    const label = await labelOf(btn);
    if (!(await guardedClick(ctx, btn, label))) break;
    if ((await capture(ctx, "showMore", { action: "click", label })) === 0) break;
  }
  // infinite scroll: scroll until the document stops growing
  let last = -1;
  for (let i = 0; i < 30; i++) {
    const h = await page.evaluate(() => { window.scrollTo(0, document.body.scrollHeight); return document.body.scrollHeight; }).catch(() => 0);
    await page.waitForTimeout(500);
    if (h === last) break;
    last = h;
  }
  await capture(ctx, "scroll", { action: "scroll" });
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => undefined);
}

async function hover(ctx: Ctx): Promise<void> {
  const page = ctx.cfg.page;
  const targets = page.locator("[aria-describedby], [title], [data-tooltip], [data-tip], .tooltip-trigger, button:has(svg[aria-label*=info i]), [aria-label*=info i]");
  const n = Math.min(await targets.count(), ctx.max);
  for (let i = 0; i < n; i++) {
    const el = targets.nth(i);
    const label = (await labelOf(el)) || (await el.getAttribute("title").catch(() => "")) || `hover ${i + 1}`;
    try { await el.hover({ timeout: 2000 }); ctx.actions++; } catch { continue; }
    await page.waitForTimeout(400);
    const before = ctx.observations.length;
    await capture(ctx, "hover", { action: "hover", label });
    if (ctx.observations.length > before) {
      const title = await el.getAttribute("title").catch(() => null);
      if (title) { /* title tooltips are also in the DOM; already captured as text if rendered */ }
    }
    await page.mouse.move(0, 0).catch(() => undefined);
  }
}

/** Close whatever a click opened: Escape first, then an explicit Close button, so the next card is clickable. */
async function closeOverlay(ctx: Ctx): Promise<void> {
  const page = ctx.cfg.page;
  await page.keyboard.press("Escape").catch(() => undefined);
  await page.waitForTimeout(200);
  const close = page.locator("button, [role=button]").filter({ hasText: /^\s*(close|dismiss|got it|ok|×|✕|x)\s*$/i }).first();
  if (await close.isVisible().catch(() => false)) { await close.click({ timeout: 2000 }).catch(() => undefined); ctx.actions++; await page.waitForTimeout(200); }
  else {
    const aria = page.locator("[aria-label=Close], [aria-label=close], [data-dismiss]").first();
    if (await aria.isVisible().catch(() => false)) { await aria.click({ timeout: 2000 }).catch(() => undefined); ctx.actions++; await page.waitForTimeout(200); }
  }
}

async function modals(ctx: Ctx): Promise<void> {
  const page = ctx.cfg.page;
  // Card buttons and expandable rows: a button that wraps a heading, a paragraph or a status badge opens a modal or
  // unfolds details (feature cards with "Learn more", integration rows). Click, capture, close with Escape.
  const cards = page.locator("button:has(h2), button:has(h3), button:has(h4), button:has(p), button[class*=justify-between], [role=button]:has(h3)");
  const cn = Math.min(await cards.count(), ctx.max);
  for (let i = 0; i < cn; i++) {
    const el = cards.nth(i);
    const label = (await labelOf(el)).split(/\s{2,}/)[0].split(String.fromCharCode(10))[0].slice(0, 60);
    if (!label || NAV_LABEL.test(label)) continue;
    const inNav = await el.evaluate((e) => Boolean(e.closest("nav, header, [role=navigation], form"))).catch(() => false);
    if (inNav) continue;
    if (await guardedClick(ctx, el, label)) {
      await capture(ctx, "modals", { action: "click", label });
      await closeOverlay(ctx);
    }
  }
  const triggers = page.locator("button, [role=button], a").filter({ hasText: /^(compare( plans| all plans)?|watch( demo| video)?|see demo|details|learn more|view details|see all features|all features)\s*[+\-–—▾▸›»]?\s*$/i });
  const n = Math.min(await triggers.count(), ctx.max);
  for (let i = 0; i < n; i++) {
    const el = triggers.nth(i); const label = await labelOf(el);
    if (await guardedClick(ctx, el, label)) {
      await capture(ctx, "modals", { action: "click", label });
      await page.keyboard.press("Escape").catch(() => undefined);
      await page.waitForTimeout(300);
    }
  }
}

async function iframes(ctx: Ctx): Promise<void> {
  const page = ctx.cfg.page;
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    const src = frame.url();
    if (!src || src === "about:blank" || THIRD_PARTY_IFRAME.test(src)) continue;
    let text = "";
    try { text = await frame.locator("body").innerText({ timeout: 2000 }); } catch { /* cross-origin */ }
    if (text && normalizeText(text).length > 20) {
      const blocks = splitBlocks(text);
      for (const block of blocks) {
        if (ctx.seen.has(block) || block.length < 3 || CODE_LIKE.test(block)) continue;
        ctx.seen.add(block);
        let obs = createObservation({
          runId: ctx.cfg.runId, jobId: ctx.cfg.jobId, competitor: ctx.cfg.competitor, url: ctx.cfg.url,
          layer: "hidden", source: "browser", kind: "text", text: block, revealedBy: { action: "none", label: `iframe ${new URL(src).hostname || new URL(src).pathname.split("/").pop() || src}` },
          vantage: ctx.cfg.handle.vantage, perception: "dom", steelSessionId: ctx.cfg.handle.sessionId,
        });
        obs = markMissedByFetch(obs, ctx.cfg.surfaceBaseline);
        await emit(ctx, obs); ctx.strategies.iframes = (ctx.strategies.iframes ?? 0) + 1;
      }
    } else {
      const obs = createObservation({
        runId: ctx.cfg.runId, jobId: ctx.cfg.jobId, competitor: ctx.cfg.competitor, url: ctx.cfg.url,
        layer: "hidden", source: "browser", kind: "link", text: src, revealedBy: { action: "none", label: "iframe" },
        vantage: ctx.cfg.handle.vantage, perception: "dom", steelSessionId: ctx.cfg.handle.sessionId,
      });
      if (!ctx.seen.has(src)) { ctx.seen.add(src); await emit(ctx, obs); }
    }
  }
}

async function documents(ctx: Ctx, viaLabel?: string): Promise<void> {
  const page = ctx.cfg.page;
  const hrefs = await page.evaluate(() => Array.from(document.querySelectorAll("a[href]")).map((a) => (a as HTMLAnchorElement).href)).catch(() => [] as string[]);
  const docs = [...new Set(hrefs.filter((h) => /\.(pdf|docx?|xlsx?|pptx?|csv)(\?|#|$)/i.test(h)))];
  for (const href of docs) {
    if (ctx.seen.has(href)) continue;
    ctx.seen.add(href);
    let obs = createObservation({
      runId: ctx.cfg.runId, jobId: ctx.cfg.jobId, competitor: ctx.cfg.competitor, url: ctx.cfg.url,
      layer: "hidden", source: "browser", kind: "document", text: href, revealedBy: viaLabel ? { action: "click", label: viaLabel } : { action: "none", label: "document link" },
      vantage: ctx.cfg.handle.vantage, perception: "dom", steelSessionId: ctx.cfg.handle.sessionId,
    });
    obs = markMissedByFetch(obs, ctx.cfg.surfaceBaseline);
    await emit(ctx, obs); ctx.strategies.documents = (ctx.strategies.documents ?? 0) + 1;
  }
}

/** Hidden-API check: JSON responses the page loaded. A value shown as "Loading…" usually comes from one of these. */
async function hiddenApi(ctx: Ctx): Promise<void> {
  for (const u of ctx.apiUrls) {
    if (ctx.seen.has(u)) continue;
    ctx.seen.add(u);
    const obs = createObservation({
      runId: ctx.cfg.runId, jobId: ctx.cfg.jobId, competitor: ctx.cfg.competitor, url: ctx.cfg.url,
      layer: "hidden", source: "browser", kind: "link", text: u, revealedBy: { action: "none", label: "json api" },
      vantage: ctx.cfg.handle.vantage, perception: "dom", steelSessionId: ctx.cfg.handle.sessionId,
    });
    await emit(ctx, obs); ctx.strategies.hiddenApi = (ctx.strategies.hiddenApi ?? 0) + 1;
  }
}

/**
 * The final pass: click every remaining clickable element that no earlier strategy handled, so nothing that hides
 * content behind an interaction is left untouched. This is the "reach everything a fetch tool cannot" pass.
 *
 * One page.evaluate marks every candidate (visible, clickable-looking, not already handled, not navigation, not in the
 * blocklist) with a data attribute, so each click is one remote round trip rather than one per element. After each
 * click we capture new visible lines; a click that navigates is undone by guardedClick and does not count as hidden
 * content. Purchase, delete and account controls are never clicked (the blocklist and the label guard below).
 */
/**
 * Site menus: the header and nav controls that unfold mega menus, product lists and feature groups. Earlier strategies
 * skip navigation on purpose (a menu link is a page for the crawl, not hidden content); this pass opens the menus that
 * only exist on hover or click and records what they show. Links inside menus are never followed here.
 */
async function menus(ctx: Ctx): Promise<void> {
  const page = ctx.cfg.page;
  const cands: Array<{ idx: number; label: string; expander: boolean }> = await page.evaluate((max) => {
    const out: Array<{ idx: number; label: string; expander: boolean }> = [];
    const roots = Array.from(document.querySelectorAll("nav, header, [role=navigation], [role=menubar]"));
    const seen = new Set<string>();
    let idx = 0;
    for (const root of roots) {
      const items = Array.from(root.querySelectorAll("button, [role=button], [role=menuitem], [aria-haspopup], [aria-expanded], li > a, li > span, li > div, summary"));
      for (const e of items) {
        if (out.length >= max) break;
        const el = e as HTMLElement;
        const href = (el as HTMLAnchorElement).href || "";
        if (el.tagName === "A" && href && !/^javascript:|#$/.test(href) && !el.hasAttribute("aria-haspopup") && !el.hasAttribute("aria-expanded")) {
          // a plain link with no submenu is a page for the crawl; a link that also owns a submenu is worth hovering
          const li = el.closest("li");
          if (!li || !li.querySelector("ul, [role=menu], [class*=submenu], [class*=dropdown], [class*=mega]")) continue;
        }
        const cs = getComputedStyle(el);
        if (cs.display === "none" || cs.visibility === "hidden") continue;
        const r = el.getBoundingClientRect();
        if (r.width < 8 || r.height < 8) continue;
        const label = ((el.innerText || el.getAttribute("aria-label") || "").trim()).replace(/\s+/g, " ").slice(0, 60);
        if (!label || seen.has(label)) continue;
        seen.add(label);
        el.setAttribute("data-periscope-menu", String(idx));
        out.push({ idx, label, expander: el.getAttribute("aria-expanded") === "false" || el.hasAttribute("aria-haspopup") });
        idx++;
      }
    }
    return out;
  }, ctx.max * 2).catch(() => [] as Array<{ idx: number; label: string; expander: boolean }>);

  for (const cand of cands) {
    if (Date.now() > ctx.deadline) break;
    if (ctx.blocked.test(cand.label)) continue;
    const el = page.locator(`[data-periscope-menu="${cand.idx}"]`).first();
    if (!(await el.count())) continue;
    // hover opens most mega menus; capture what appeared
    try { await el.hover({ timeout: 2000 }); ctx.actions++; } catch { continue; }
    await page.waitForTimeout(350);
    let n = await capture(ctx, "menus", { action: "hover", label: cand.label });
    // still closed? click it (the URL guard undoes a navigation)
    if (n === 0 && cand.expander && (await guardedClick(ctx, el, cand.label))) {
      n = await capture(ctx, "menus", { action: "click", label: cand.label });
      await page.keyboard.press("Escape").catch(() => undefined);
    }
    await page.mouse.move(0, 0).catch(() => undefined);
  }
}

async function sweep(ctx: Ctx): Promise<void> {
  const page = ctx.cfg.page;
  const budget = Math.max(ctx.max * 3, 40); // this pass is allowed more clicks than a single strategy
  const cands: Array<{ idx: number; label: string }> = await page.evaluate((max) => {
    const out: Array<{ idx: number; label: string }> = [];
    const seen = new Set<string>();
    // anything a user could click that might unfold content; links stay in the crawl, so only same-page controls here
    const sel = "button, [role=button], [role=tab], [role=menuitem], [aria-expanded], [aria-haspopup], [aria-controls], summary, [data-toggle], [data-accordion], [data-collapse], [data-state], [onclick], [tabindex]:not([tabindex='-1']), "
      + "[class*=accordion], [class*=collaps], [class*=expand], [class*=toggle], [class*=dropdown], [class*=disclosure], [class*=faq], [class*=tab-], [class*=Tab]";
    const els = Array.from(document.querySelectorAll(sel)) as Element[];
    // custom controls: headings and boxes styled as clickable (cursor: pointer) that carry no button semantics at all
    for (const e of Array.from(document.querySelectorAll("h2, h3, h4, h5, div, span, li, p, dt, section"))) {
      if (els.length > max * 6) break;
      const el = e as HTMLElement;
      if (el.closest("a, button, [role=button], nav, header, footer, form")) continue;
      if (getComputedStyle(el).cursor !== "pointer") continue;
      const text = (el.innerText || "").trim();
      if (!text || text.length > 140) continue; // a whole clickable card is too big to be a control
      els.push(el);
    }
    let idx = 0;
    for (const e of els) {
      if (out.length >= max) break;
      const el = e as HTMLElement;
      if (el.hasAttribute("data-periscope-done")) continue;
      // skip navigation, forms, headers, footers, and anything that is really a link
      if (el.closest("nav, header, footer, form, [role=navigation], [role=menubar]")) continue;
      if (el.tagName === "A" && (el as HTMLAnchorElement).href) continue;
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) < 0.05) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) continue;
      const label = ((el.innerText || el.getAttribute("aria-label") || el.getAttribute("title") || "").trim()).replace(/\s+/g, " ").slice(0, 60);
      const key = label || `el-${idx}`;
      if (label && seen.has(label)) continue;
      seen.add(key);
      el.setAttribute("data-periscope-sweep", String(idx));
      out.push({ idx, label });
      idx++;
    }
    return out;
  }, budget).catch(() => [] as Array<{ idx: number; label: string }>);

  for (const cand of cands) {
    if (ctx.actions >= budget) break;
    if (!cand.label || NAV_LABEL.test(cand.label) || ctx.blocked.test(cand.label)) continue;
    const el = page.locator(`[data-periscope-sweep="${cand.idx}"]`).first();
    if (!(await el.count())) continue;
    const inState = await el.getAttribute("aria-expanded").catch(() => null);
    if (await guardedClick(ctx, el, cand.label || "element")) {
      await capture(ctx, "sweep", { action: "click", label: cand.label || "element" });
      // collapse it again if it was an expander, so later clicks and the screenshot see a tidy page
      if (inState === "false") await guardedClick(ctx, el, cand.label || "element").catch(() => false);
      else await page.keyboard.press("Escape").catch(() => undefined);
    }
    await el.evaluate((e) => e.setAttribute("data-periscope-done", "1")).catch(() => undefined);
  }
}

/* ---------------- orchestration ---------------- */

export async function revealDeterministic(cfg: DeterministicRevealConfig): Promise<DeterministicRevealResult> {
  const page = cfg.page;
  const apiUrls = new Set<string>();
  const onResponse = (r: { url(): string; headers(): Record<string, string> }) => {
    const ct = r.headers()["content-type"] ?? "";
    if (/application\/json/i.test(ct) && !/analytics|gtm|segment|sentry|firebase|hotjar/i.test(r.url())) apiUrls.add(r.url());
  };
  page.on("response", onResponse);

  if (page.url() !== cfg.url) await page.goto(cfg.url, { waitUntil: "load", timeout: 60_000 });
  else await page.reload({ waitUntil: "load", timeout: 60_000 }).catch(() => undefined); // the listener must see the page's own API calls
  await page.waitForTimeout(1200);

  // Wait for the page to settle. Blog and app pages keep rendering for seconds after "load"; a baseline taken too early
  // makes ordinary late content look like it was revealed by the first click (seen on deepmark.me: 300 "toggle" lines
  // that were just the article arriving). Poll until the visible text stops growing, up to six more seconds.
  let baselineLines = await visibleLines(page);
  for (let i = 0; i < 8; i++) {
    await page.waitForTimeout(700);
    const again = await visibleLines(page);
    const settled = again.length === baselineLines.length;
    baselineLines = again;
    if (settled) break;
  }
  const baseline = baselineLines.join("\n");
  const ctx: Ctx = {
    cfg, baseline, seen: new Set(baselineLines), observations: [], actions: 0,
    max: cfg.maxActionsPerStrategy ?? 12, blocked: loadBlocklist(cfg.blocklistPath ?? "fixtures/blocklist.json"),
    strategies: {}, apiUrls, deadline: Date.now() + (cfg.maxMsPerPage ?? 180_000),
  };

  // A page that renders in the browser but not in the fetch (React/Next apps with no server HTML) hides everything
  // from a fetch tool, not just what sits behind clicks. When the browser sees far more on load than the fetch did,
  // record the rendered lines too, so the coverage says "fetch saw 2, the browser saw 180" instead of hiding it.
  const surfaceLineCount = cfg.surfaceBaseline.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length >= 3).length;
  const renderedOnly = !cfg.emitBaselineAs && baselineLines.length > 3 * surfaceLineCount + 5;
  const baselineLayer = cfg.emitBaselineAs ?? (renderedOnly ? "hidden" : undefined);
  if (baselineLayer) {
    for (const line of baselineLines) {
      if (CODE_LIKE.test(line)) continue;
      let obs = createObservation({
        runId: cfg.runId, jobId: cfg.jobId, competitor: cfg.competitor, url: cfg.url,
        layer: baselineLayer, source: "browser", kind: /\$|€|£|\d+(\.\d+)?\s*(\/|per)\s*(mo|month|yr|year|user|seat)/i.test(line) ? "price" : "text",
        text: line, revealedBy: renderedOnly ? { action: "none", label: "rendered by browser" } : { action: "none" }, vantage: cfg.handle.vantage, perception: "dom", steelSessionId: cfg.handle.sessionId,
      });
      obs = markMissedByFetch(obs, cfg.surfaceBaseline);
      ctx.observations.push(obs);
      await cfg.sink.write({ type: "observation", data: obs });
    }
  }

  const all: Record<StrategyName, (c: Ctx) => Promise<void>> = {
    consent: consentWalls, menus, tabs: tabsAndAccordions, selects, toggles, showMore, hover, modals, iframes, documents: (c) => documents(c), hiddenApi, sweep,
  };
  const order: StrategyName[] = cfg.strategies ?? ["consent", "tabs", "selects", "toggles", "showMore", "hover", "modals", "iframes", "documents", "hiddenApi", "menus", "sweep"];
  const strategies: Array<[string, (c: Ctx) => Promise<void>]> = order.map((n) => [n, all[n]]);
  for (const [name, fn] of strategies) {
    if (Date.now() > ctx.deadline && name !== "documents" && name !== "hiddenApi") continue; // out of time: only the free passes remain
    try { await fn(ctx); } catch (err) { console.error(`deterministic reveal ${name} failed:`, (err as Error).message.slice(0, 120)); }
  }
  page.off("response", onResponse);

  const missed = ctx.observations.filter((o) => o.missedByFetch).length;
  await cfg.sink.write({ type: "counter", data: { competitor: cfg.competitor, url: cfg.url, missed } });
  // the links the rendered page carries, after every menu and panel has been opened: the crawl's next frontier
  const links: string[] = await page.evaluate(() => Array.from(document.querySelectorAll("a[href]")).map((a) => (a as HTMLAnchorElement).href).filter((h) => /^https?:/.test(h))).catch(() => [] as string[]);
  return { observations: ctx.observations, missedByFetch: missed, actions: ctx.actions, strategies: ctx.strategies, links: [...new Set(links)] };
}
