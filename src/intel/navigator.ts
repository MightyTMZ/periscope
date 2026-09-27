// The navigator: before the browsers open, Claude reads the site map and says what each page is and in what order the
// pages deserve a browser. Rules (PageRank plus words in the path) already give a sensible order; the model adds what
// rules cannot see: that /solutions/finance is a product page and /blog/2024-recap is not, that /compare matters more
// than /about, that a docs hub deserves depth. Nothing is skipped: every page still opens, the model only sets the
// order and labels the map for the brief. Output is validated against the real url list; unknown urls are ignored.
import type { Complete } from "./extract.js";

export type PageType = "landing" | "pricing" | "product" | "features" | "compare" | "docs" | "help" | "security" | "enterprise" | "integrations" | "customers" | "company" | "careers" | "legal" | "blog" | "login" | "other";

export interface SitePlan {
  /** Every known url, best first. */
  order: string[];
  types: Map<string, PageType>;
  /** One line from the model on what kind of site this is. */
  read: string;
  tokensIn: number;
  tokensOut: number;
}

const SCHEMA = {
  type: "object",
  properties: {
    read: { type: "string" },
    pages: { type: "array", items: { type: "object", properties: { url: { type: "string" }, type: { type: "string", enum: ["landing", "pricing", "product", "features", "compare", "docs", "help", "security", "enterprise", "integrations", "customers", "company", "careers", "legal", "blog", "login", "other"] }, priority: { type: "integer", minimum: 1, maximum: 5 } }, required: ["url", "type", "priority"] } },
  },
  required: ["read", "pages"],
};

export async function planSite(opts: { competitor: string; urls: string[]; complete: Complete; cap?: number }): Promise<SitePlan> {
  const urls = opts.urls.slice(0, opts.cap ?? 400);
  const known = new Set(urls);
  const list = urls.map((u, i) => `${i + 1}. ${u}`).join("\n");
  const system = [
    "You plan a competitive-intelligence crawl. Given every url of a competitor's site, label each page and rank how much it can tell a rival about pricing, packaging, limits, features, security posture and go-to-market.",
    "priority 5: pricing, plans, compare, enterprise, limits/quotas, security/trust, product and feature pages. 4: docs and help centers, integrations, changelog. 3: customers, solutions by industry, landing. 2: company, about, contact, careers. 1: blog posts, news, legal, tags.",
    "Read the path carefully: /solutions/finance is product, /blog/x is blog, /docs/api/y is docs. Return every url you were given, once, with a type and a priority. read: one sentence on what the company sells and how it seems to price.",
  ].join(" ");
  const { input, tokensIn, tokensOut } = await opts.complete({ system, user: `Competitor: ${opts.competitor}\n\nUrls (${urls.length}):\n${list}`, toolName: "record_plan", schema: SCHEMA, maxTokens: 12_000 });
  const raw = (input ?? {}) as { read?: unknown; pages?: unknown };
  const types = new Map<string, PageType>();
  const prio = new Map<string, number>();
  for (const p of Array.isArray(raw.pages) ? raw.pages : []) {
    const it = p as { url?: unknown; type?: unknown; priority?: unknown };
    if (typeof it.url !== "string" || !known.has(it.url)) continue;
    types.set(it.url, (typeof it.type === "string" ? it.type : "other") as PageType);
    prio.set(it.url, typeof it.priority === "number" ? Math.max(1, Math.min(5, it.priority)) : 3);
  }
  // model order first (priority, then the original rank)
  const order = [...urls].sort((a, b) => (prio.get(b) ?? 3) - (prio.get(a) ?? 3) || urls.indexOf(a) - urls.indexOf(b)); // forgotten pages sit in the middle, in their original order
  return { order, types, read: typeof raw.read === "string" ? raw.read.slice(0, 300) : "", tokensIn, tokensOut };
}
