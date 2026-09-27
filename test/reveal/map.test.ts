// B-map: whole-site discovery and ranking, fully offline (fetch is faked).
import { describe, expect, it } from "vitest";
import { chunkForBrowsers, discoverSite, extractLinks, keywordScore, normalizeUrl, pageRank, rankPages } from "../../src/map.js";

const ORIGIN = "https://acme.example";
const page = (links: string[], extra = "") => `<html><body>${links.map((l) => `<a href="${l}">x</a>`).join("")}${extra}</body></html>`;

const site: Record<string, string> = {
  "/": page(["/pricing", "/features", "/blog", "/docs", "/about", "/careers", "/pricing#faq", "/pricing?utm_source=x"]),
  "/pricing": page(["/", "/features", "/pricing/enterprise", "/security", "/legal/terms", "/whitepaper.pdf", "https://docs.google.com/spreadsheets/d/abc"]),
  "/features": page(["/", "/pricing", "/docs", "/integrations"]),
  "/docs": page(["/", "/docs/api", "/docs/limits"]),
  "/docs/api": page(["/docs", "/docs/limits"]),
  "/docs/limits": page(["/docs"]),
  "/blog": page(["/", "/blog/post-1", "/blog/post-2", "/pricing"]),
  "/blog/post-1": page(["/blog", "/pricing"]),
  "/blog/post-2": page(["/blog"]),
  "/about": page(["/", "/careers"]),
  "/careers": page(["/about"]),
  "/security": page(["/", "/pricing"]),
  "/pricing/enterprise": page(["/pricing"]),
  "/integrations": page(["/features"]),
  "/legal/terms": page(["/"]),
  "/secret": page(["/"]),
};
const robots = "User-agent: *\nDisallow: /secret\nSitemap: https://acme.example/sitemap.xml\n";
const sitemap = `<?xml version="1.0"?><urlset>${["/", "/pricing", "/features", "/docs", "/docs/api", "/docs/limits", "/security", "/integrations", "/blog", "/about"].map((p) => `<url><loc>${ORIGIN}${p}</loc></url>`).join("")}</urlset>`;

const fakeFetch: typeof fetch = async (input) => {
  const u = new URL(String(input));
  const body = u.pathname === "/robots.txt" ? robots : u.pathname === "/sitemap.xml" ? sitemap : site[u.pathname];
  if (body === undefined) return new Response("nope", { status: 404 });
  const type = u.pathname === "/robots.txt" ? "text/plain" : u.pathname === "/sitemap.xml" ? "application/xml" : "text/html; charset=utf-8";
  return new Response(body, { status: 200, headers: { "content-type": type } });
};

describe("map: urls and links", () => {
  it("normalizes the same page to one node", () => {
    expect(normalizeUrl("/pricing#faq", ORIGIN)).toBe(`${ORIGIN}/pricing`);
    expect(normalizeUrl("/pricing?utm_source=x", ORIGIN)).toBe(`${ORIGIN}/pricing`);
    expect(normalizeUrl("/pricing/", ORIGIN)).toBe(`${ORIGIN}/pricing`);
    expect(normalizeUrl("mailto:a@b.c", ORIGIN)).toBeNull();
  });
  it("extracts hrefs in every quoting style", () => {
    const links = extractLinks(`<a href="/a">1</a><A HREF='/b'>2</A><a href=/c>3</a><a href="tel:1">4</a>`, ORIGIN);
    expect(links).toEqual([`${ORIGIN}/a`, `${ORIGIN}/b`, `${ORIGIN}/c`]);
  });
  it("prefers product pages over noise", () => {
    expect(keywordScore(`${ORIGIN}/pricing`)).toBeGreaterThan(keywordScore(`${ORIGIN}/features`));
    expect(keywordScore(`${ORIGIN}/features`)).toBeGreaterThan(keywordScore(`${ORIGIN}/blog/post-1`));
    expect(keywordScore(`${ORIGIN}/legal/terms`)).toBeLessThan(0);
  });
});

describe("map: graph", () => {
  it("pagerank favours the page everyone links to", () => {
    const nodes = ["a", "b", "c", "d"];
    const pr = pageRank(nodes, [["b", "a"], ["c", "a"], ["d", "a"], ["a", "b"]]);
    expect(pr.get("a")!).toBeGreaterThan(pr.get("c")!);
    expect([...pr.values()].reduce((x, y) => x + y, 0)).toBeCloseTo(1, 5);
  });
  it("keeps the start page first and drops deep noise to the bottom", () => {
    const nodes = ["s", "s/pricing", "s/blog/x/y/z"];
    const ranked = rankPages("s", nodes, [["s", "s/pricing"], ["s", "s/blog/x/y/z"]], new Map([["s", 0], ["s/pricing", 1], ["s/blog/x/y/z", 4]]));
    expect(ranked[0][0]).toBe("s");
    expect(ranked[ranked.length - 1][0]).toBe("s/blog/x/y/z");
  });
  it("spreads the best pages across browsers, best first in each", () => {
    const chunks = chunkForBrowsers(["p1", "p2", "p3", "p4", "p5", "p6", "p7"], 8, 3);
    expect(chunks.length).toBe(3);
    expect(chunks[0][0]).toBe("p1");
    expect(chunks.flat().sort()).toEqual(["p1", "p2", "p3", "p4", "p5", "p6", "p7"]);
  });
});

describe("map: discovery over a fake site", () => {
  it("uses robots, sitemap and a crawl, ranks pricing above blog, records documents, honours Disallow", async () => {
    const lines: string[] = [];
    const m = await discoverSite({ root: ORIGIN, maxPages: 6, fetchImpl: fakeFetch, log: (l) => lines.push(l), concurrency: 2 });
    expect(m.sitemap).toBe(true);
    expect(m.pages[0]).toBe(`${ORIGIN}/`);
    expect(m.pages.slice(0, 3)).toContain(`${ORIGIN}/pricing`);
    expect(m.pages).not.toContain(`${ORIGIN}/blog/post-2`);
    expect(m.pages).not.toContain(`${ORIGIN}/secret`);
    expect(m.pages).not.toContain(`${ORIGIN}/legal/terms`);
    expect(m.documents).toContain(`${ORIGIN}/whitepaper.pdf`);
    expect(m.documents.some((d) => d.includes("docs.google.com"))).toBe(true);
    expect(m.nodes).toBeGreaterThanOrEqual(12);
    expect(m.edges).toBeGreaterThan(10);
    expect(lines.some((l) => l.startsWith("crawl:"))).toBe(true);
  });
  it("falls back to the start page alone when nothing can be fetched", async () => {
    const dead: typeof fetch = async () => { throw new Error("offline"); };
    const m = await discoverSite({ root: ORIGIN, start: `${ORIGIN}/pricing`, fetchImpl: dead, timeoutMs: 100 });
    expect(m.pages).toEqual([`${ORIGIN}/pricing`]);
    expect(m.sitemap).toBe(false);
  });
});

describe("map: robots", () => {
  it("matches wildcard and anchored rules without blocking everything", async () => {
    const { robotsMatcher } = await import("../../src/map.js");
    const block = robotsMatcher(["/*/pulse", "/secret", "/tmp$", "/search?*"]);
    expect(block("https://x.example/a/pulse")).toBe(true);
    expect(block("https://x.example/secret/page")).toBe(true);
    expect(block("https://x.example/tmp")).toBe(true);
    expect(block("https://x.example/tmpfile")).toBe(false);
    expect(block("https://x.example/pricing")).toBe(false);
    expect(robotsMatcher(["/"])("https://x.example/pricing")).toBe(true);
  });
});

describe("map: host forms", () => {
  it("treats www and bare host as one page", () => {
    expect(normalizeUrl("https://acme.example/about", "https://www.acme.example/")).toBe("https://www.acme.example/about");
    expect(normalizeUrl("https://www.acme.example/about", "https://acme.example/")).toBe("https://acme.example/about");
    expect(normalizeUrl("https://other.example/about", "https://acme.example/")).toBe("https://other.example/about");
  });
});
