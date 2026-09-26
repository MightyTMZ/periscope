// Whole-site map: find every page of a competitor's site before any browser opens, then decide which ones deserve one.
//
// Discovery is cheap on purpose: robots.txt and sitemap.xml first, then a breadth-first crawl of same-origin links over
// plain HTTP. No Steel session is spent until the ranking is done. Ranking is graph theory plus words: PageRank over the
// link graph (pages many other pages point to matter more) combined with what the path says (pricing beats blog) and a
// depth penalty (three clicks from home is worth less than one). The top `maxPages` pages then get the full reveal
// treatment in parallel browsers; every document link on those pages is recorded by the reveal's documents strategy.

export interface SiteMap {
  /** Ranked page urls, best first, start page always first. */
  pages: string[];
  /** Score per url (for the trace and for tests). */
  scores: Map<string, number>;
  /** Same-origin pages seen (nodes) and links between them (edges). */
  nodes: number;
  edges: number;
  /** Where the list came from. */
  sitemap: boolean;
  fetched: number;
  documents: string[];
}

export interface DiscoverOptions {
  root: string;              // site origin or any url on it
  start?: string;            // first page; defaults to root
  maxPages?: number;         // pages to hand to browsers (default 30)
  maxFetch?: number;         // html pages to fetch during discovery (default 120)
  concurrency?: number;      // parallel fetches (default 6)
  timeoutMs?: number;        // per fetch (default 10s)
  fetchImpl?: typeof fetch;  // tests inject one
  log?: (line: string) => void;
}

const UA = "Mozilla/5.0 (compatible; Periscope/1.0; +https://github.com/FahadNafeesAhmed/periscope)";

/** Paths that say "this page is the product": open these first. */
const WANT: Array<[RegExp, number]> = [
  [/pric|plans?\b|billing|cost|quote/i, 6],
  [/compar|vs\b|versus|alternative/i, 5],
  [/feature|product|platform|capabilit|solution/i, 4],
  [/enterprise|business|teams?\b|startup/i, 3],
  [/security|compliance|trust|soc\s?2|gdpr|privacy-center|status/i, 3],
  [/integration|api\b|developer|docs?\b|documentation|reference|sdk/i, 3],
  [/limits?|quota|fair-?use|usage|faq|help|support/i, 3],
  [/changelog|release|whats-new|roadmap|updates/i, 2],
  [/customer|case-?stud|testimonial|partners?/i, 1],
];
/** Paths that are noise for a competitor map: open these last, if at all. */
const AVOID: Array<[RegExp, number]> = [
  [/\/blog|\/news|\/press|\/events?\/|\/webinar|\/podcast|\/newsletter/i, 4],
  [/\/careers?|\/jobs?\b|\/hiring|\/legal|\/terms|\/privacy(?!-center)|\/cookie|\/gdpr-policy|\/imprint|\/sitemap/i, 5],
  [/\/tag\/|\/tags\/|\/category\/|\/categories\/|\/author\/|\/page\/\d|\/feed\b|\/rss|\/search\b|\/login|\/sign-?in|\/sign-?up|\/register|\/logout|\/cart|\/checkout|\/purchase|\/buy\b|\/order\b|\/subscribe|\/unsubscribe/i, 6],
  [/\.(pdf|docx?|xlsx?|pptx?|csv|zip|png|jpe?g|gif|svg|webp|mp4|mp3|ico|css|js|json|xml)(\?|$)/i, 9],
];
/** Links to files and shared documents: recorded, never opened as a page. */
const DOCUMENT = /\.(pdf|docx?|xlsx?|pptx?|csv|zip)(\?|$)|docs\.google\.com|drive\.google\.com|sheets\.google\.com|slides\.google\.com|dropbox\.com\/s|notion\.site|notion\.so|box\.com\/s|figma\.com\/(file|proto|design)|loom\.com\/share|youtube\.com\/watch|youtu\.be/i;
const SKIP_QUERY = /^(utm_|ref$|fbclid|gclid|mc_cid|mc_eid|locale$|lang$|hl$|cft$)/i;

export function keywordScore(url: string): number {
  let s = 0;
  const path = safePath(url);
  for (const [re, w] of WANT) if (re.test(path)) s += w;
  for (const [re, w] of AVOID) if (re.test(path)) s -= w;
  return s;
}

function safePath(url: string): string {
  try { const u = new URL(url); return u.pathname + u.search; } catch { return url; }
}

/** Canonical form so the same page is one node: no hash, no tracking params, no trailing slash, lower-case host. */
export function normalizeUrl(href: string, base: string): string | null {
  let u: URL;
  try { u = new URL(href, base); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  u.hash = "";
  u.hostname = u.hostname.toLowerCase();
  for (const k of [...u.searchParams.keys()]) if (SKIP_QUERY.test(k)) u.searchParams.delete(k);
  let s = u.toString();
  if (u.pathname !== "/" && s.endsWith("/")) s = s.slice(0, -1);
  return s;
}

export function sameSite(a: string, b: string): boolean {
  try {
    const ha = new URL(a).hostname.replace(/^www\./, ""), hb = new URL(b).hostname.replace(/^www\./, "");
    return ha === hb;
  } catch { return false; }
}

export function extractLinks(html: string, base: string): string[] {
  const out = new Set<string>();
  const re = /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const raw = (m[1] ?? m[2] ?? m[3] ?? "").trim();
    if (!raw || raw.startsWith("mailto:") || raw.startsWith("tel:") || raw.startsWith("javascript:")) continue;
    const n = normalizeUrl(raw.replace(/&amp;/g, "&"), base);
    if (n) out.add(n);
  }
  return [...out];
}

function extractLocs(xml: string): string[] {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]);
}

/** Simple robots.txt: Disallow lines for User-agent: * (Periscope crawls politely; the reveal browser is a real visitor). */
function parseRobots(txt: string): { disallow: string[]; sitemaps: string[] } {
  const disallow: string[] = []; const sitemaps: string[] = [];
  let applies = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const [k, ...rest] = line.split(":"); const v = rest.join(":").trim();
    const key = k.trim().toLowerCase();
    if (key === "user-agent") applies = v === "*";
    else if (key === "sitemap") sitemaps.push(v);
    else if (key === "disallow" && applies && v) disallow.push(v);
  }
  return { disallow, sitemaps };
}

/** Turn robots.txt Disallow rules (with * and $) into one test over a url's path. */
export function robotsMatcher(rules: string[]): (url: string) => boolean {
  const res = rules.map((rule) => {
    const anchored = rule.endsWith("$"); const body = anchored ? rule.slice(0, -1) : rule;
    const src = "^" + body.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + (anchored ? "$" : "");
    return new RegExp(src);
  });
  return (url: string) => { const p = safePath(url); return res.some((re) => re.test(p)); };
}

/** PageRank over the link graph. Nodes nobody links to keep the base rank; damping 0.85; 20 rounds is plenty for a site. */
export function pageRank(nodes: string[], edges: Array<[string, string]>, rounds = 20, d = 0.85): Map<string, number> {
  const n = nodes.length; if (!n) return new Map();
  const idx = new Map(nodes.map((u, i) => [u, i]));
  const out: number[][] = nodes.map(() => []);
  for (const [a, b] of edges) { const i = idx.get(a), j = idx.get(b); if (i !== undefined && j !== undefined && i !== j) out[i].push(j); }
  let rank = new Array(n).fill(1 / n);
  for (let r = 0; r < rounds; r++) {
    const next = new Array(n).fill((1 - d) / n);
    let dangling = 0;
    for (let i = 0; i < n; i++) {
      if (!out[i].length) { dangling += rank[i]; continue; }
      const share = (d * rank[i]) / out[i].length;
      for (const j of out[i]) next[j] += share;
    }
    for (let i = 0; i < n; i++) next[i] += (d * dangling) / n;
    rank = next;
  }
  return new Map(nodes.map((u, i) => [u, rank[i]]));
}

/** Final order: words + graph + depth. Start page always first. */
export function rankPages(start: string, nodes: string[], edges: Array<[string, string]>, depth: Map<string, number>): Array<[string, number]> {
  const pr = pageRank(nodes, edges);
  const maxPr = Math.max(...pr.values(), 1e-9);
  const scored = nodes.map((u): [string, number] => {
    const graph = 4 * Math.sqrt((pr.get(u) ?? 0) / maxPr);           // 0..4, square root so a few hub pages do not drown the rest
    const dep = depth.get(u) ?? 3;
    const s = keywordScore(u) + graph - 0.8 * Math.min(dep, 5);
    return [u, u === start ? s + 100 : s];
  });
  return scored.sort((a, b) => b[1] - a[1] || a[0].length - b[0].length);
}

export async function discoverSite(opts: DiscoverOptions): Promise<SiteMap> {
  const f = opts.fetchImpl ?? fetch;
  const log = opts.log ?? (() => {});
  const maxPages = opts.maxPages ?? 30, maxFetch = opts.maxFetch ?? 120, concurrency = opts.concurrency ?? 6, timeoutMs = opts.timeoutMs ?? 10_000;
  const origin = new URL(opts.root).origin;
  const start = normalizeUrl(opts.start ?? opts.root, origin) ?? origin;

  const get = async (url: string, accept: string): Promise<string | null> => {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await f(url, { headers: { "user-agent": UA, accept }, redirect: "follow", signal: ctl.signal });
      if (!r.ok) return null;
      const type = r.headers.get("content-type") ?? "";
      if (accept.startsWith("text/html") && !/html|xhtml/i.test(type)) return null;
      return await r.text();
    } catch { return null; } finally { clearTimeout(t); }
  };

  // 1. robots.txt: what not to crawl, and where the sitemap is.
  const robots = parseRobots((await get(`${origin}/robots.txt`, "text/plain")) ?? "");
  const disallowed = robotsMatcher(robots.disallow);

  // 2. sitemap: the full page list for free, when the site publishes one.
  const nodes = new Set<string>([start]);
  const depth = new Map<string, number>([[start, 0]]);
  const edges: Array<[string, string]> = [];
  const documents = new Set<string>();
  let sitemapUsed = false;
  const sitemapUrls = robots.sitemaps.length ? robots.sitemaps : [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`];
  const seenMaps = new Set<string>();
  for (const sm of sitemapUrls) {
    const queue = [sm]; let opened = 0;
    while (queue.length && opened < 12) {
      const u = queue.shift()!; if (seenMaps.has(u)) continue; seenMaps.add(u); opened += 1;
      const xml = await get(u, "application/xml,text/xml,*/*"); if (!xml) continue;
      const locs = extractLocs(xml);
      if (/<sitemapindex/i.test(xml)) { queue.push(...locs.slice(0, 12)); continue; }
      for (const loc of locs) {
        const n = normalizeUrl(loc, origin); if (!n || !sameSite(n, origin)) continue;
        if (DOCUMENT.test(n)) { documents.add(n); continue; }
        if (!nodes.has(n)) { nodes.add(n); depth.set(n, Math.max(1, n.replace(origin, "").split("/").filter(Boolean).length)); sitemapUsed = true; }
      }
    }
  }
  if (sitemapUsed) log(`sitemap: ${nodes.size} pages`);

  // 3. breadth-first crawl over plain fetch: follow same-origin links, build the graph, collect documents.
  const queue: string[] = [start];
  const fetchedSet = new Set<string>();
  // when a sitemap exists, still fetch the highest-value pages so the graph has edges to rank with
  if (sitemapUsed) for (const [u] of [...nodes].map((u): [string, number] => [u, keywordScore(u)]).sort((a, b) => b[1] - a[1]).slice(0, maxFetch)) if (u !== start) queue.push(u);
  let fetched = 0;
  const worker = async () => {
    while (queue.length && fetched < maxFetch) {
      const u = queue.shift()!;
      if (fetchedSet.has(u) || disallowed(u)) continue;
      fetchedSet.add(u); fetched += 1;
      const html = await get(u, "text/html,application/xhtml+xml"); if (!html) continue;
      const d = depth.get(u) ?? 0;
      for (const link of extractLinks(html, u)) {
        if (DOCUMENT.test(link)) { documents.add(link); continue; }
        if (!sameSite(link, origin)) continue;
        if (AVOID[3][0].test(link)) continue;
        if (!nodes.has(link)) { nodes.add(link); depth.set(link, d + 1); if (d + 1 <= 3) queue.push(link); }
        edges.push([u, link]);
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  log(`crawl: fetched ${fetched} pages, ${nodes.size} pages known, ${edges.length} links, ${documents.size} documents`);

  const ranked = rankPages(start, [...nodes].filter((u) => !disallowed(u) || u === start), edges, depth);
  const pages = ranked.slice(0, Math.max(1, maxPages)).map(([u]) => u);
  return { pages, scores: new Map(ranked), nodes: nodes.size, edges: edges.length, sitemap: sitemapUsed, fetched, documents: [...documents] };
}

/** Split the ranked pages across browsers: best pages spread across sessions so the first results land early. */
export function chunkForBrowsers(pages: string[], browsers: number, perBrowser: number): string[][] {
  const n = Math.max(1, Math.min(browsers, Math.ceil(pages.length / Math.max(1, perBrowser))));
  const out: string[][] = Array.from({ length: n }, () => []);
  pages.forEach((p, i) => out[i % n].push(p));
  return out.filter((c) => c.length);
}
