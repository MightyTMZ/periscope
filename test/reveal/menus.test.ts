// B-menus: header menus that open on hover, and custom clickable headings with no button semantics, are both opened.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { revealDeterministic } from "../../src/reveal-deterministic.js";

describe("deterministic reveal: menus and pointer-cursor controls", () => {
  let browser: import("playwright-core").Browser, page: import("playwright-core").Page;
  let texts: string[] = [], labels: string[] = [];
  beforeAll(async () => {
    const { localPage, MemorySink, fakeHandle, fixtureUrl } = await import("../steel/helpers.js");
    ({ browser, page } = await localPage());
    const u = fixtureUrl("menus-page.html");
    await page.goto(u, { waitUntil: "load" });
    const res = await revealDeterministic({ runId: "r", jobId: "j", competitor: "fixture", url: u, surfaceBaseline: "Widget Co", page, handle: fakeHandle(page), sink: new MemorySink(), maxActionsPerStrategy: 8 });
    texts = res.observations.map((o) => o.text); labels = res.observations.map((o) => o.revealedBy?.label ?? "");
  }, 60_000);
  afterAll(async () => { await browser?.close(); });

  it("opens the hover mega menu and records what it shows", () => {
    expect(texts.some((t) => /Audit Vault: 7 year retention/.test(t))).toBe(true);
    expect(labels).toContain("Products");
  });
  it("clicks headings styled as controls (cursor: pointer) and records the answers", () => {
    expect(texts.some((t) => /starts at 5 seats/.test(t))).toBe(true);
    expect(texts.some((t) => /GST is added/.test(t))).toBe(true);
  });
  it("never follows the Pricing link out of the page", () => {
    expect(page.url()).toMatch(/menus-page\.html$/);
  });
});
