// The typed sign-in: a two-step email-then-password form, submitted with the login the person provided.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { tryTypedLogin } from "../../src/walker-deterministic.js";

describe("typed login", () => {
  let browser: Browser, page: Page, url = "";
  beforeAll(async () => {
    const { localPage, fixtureUrl } = await import("../steel/helpers.js");
    ({ browser, page } = await localPage());
    url = fixtureUrl("two-step-login.html");
  }, 60_000);
  afterAll(async () => { await browser?.close(); });

  it("types the email, continues, types the password, and lands on the dashboard", async () => {
    await page.goto(url, { waitUntil: "load" });
    const r = await tryTypedLogin(page, { username: "me@example.com", password: "hunter2" });
    expect(r.ok).toBe(true);
    expect(await page.locator("h1").innerText()).toContain("Welcome back");
  });
  it("reports the site's own error when the password is wrong", async () => {
    await page.goto(url, { waitUntil: "load" });
    const r = await tryTypedLogin(page, { username: "me@example.com", password: "nope" });
    expect(r.ok).toBe(false);
    expect(r.reason.toLowerCase()).toContain("invalid");
  });
});
