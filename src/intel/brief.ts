// The brief: Claude reads everything a run collected (every observation with its id, the country grid, the prices,
// the documents, the coverage per page) and looks at screenshots of the pages that hid the most, then writes a
// structured competitive brief. Every claim carries observation ids; ids the model invents are dropped in code, and
// a claim with no surviving evidence is dropped with them. The model never sees the site live, only what the
// browsers brought back, so the brief can only say what Periscope can prove.
import { existsSync, readFileSync } from "node:fs";
import type { Storage } from "@periscope/knowledge";
import type { Observation } from "@periscope/contracts";
import type { Complete } from "./extract.js";
import { bordersGrid } from "./borders-grid.js";
import { coverage } from "./coverage.js";
import { priceRows } from "./prices.js";

export interface Cited { evidenceIds: string[] }
export interface Brief {
  headline: string;
  summary: string[];
  pricing: Array<Cited & { plan: string; price: string; period: string | null; currency: string | null; country: string | null; note: string | null }>;
  hidden_findings: Array<Cited & { finding: string; revealed_by: string; why_it_matters: string; page: string }>;
  country_differences: Array<Cited & { item: string; by_country: Array<{ country: string; value: string }> }>;
  limits_and_features: Array<Cited & { feature: string; value: string }>;
  signed_in_findings: Array<Cited & { finding: string; screen: string }>;
  documents: Array<{ title: string; url: string }>;
  what_a_fetch_tool_misses: Array<Cited & { text: string; because: string }>;
  gaps: string[];
  confidence: "high" | "medium" | "low";
  model: string;
  generatedAt: string;
  observationsRead: number;
  screenshotsRead: number;
  tokensIn: number;
  tokensOut: number;
}

const CITED = (extra: Record<string, unknown>) => ({
  type: "object",
  properties: { ...extra, evidenceIds: { type: "array", items: { type: "string" } } },
  required: [...Object.keys(extra), "evidenceIds"],
});
const S = { type: "string" }, SN = { type: ["string", "null"] };

export const BRIEF_SCHEMA = {
  type: "object",
  properties: {
    headline: S,
    summary: { type: "array", items: S, minItems: 2, maxItems: 8 },
    pricing: { type: "array", items: CITED({ plan: S, price: S, period: SN, currency: SN, country: SN, note: SN }) },
    hidden_findings: { type: "array", items: CITED({ finding: S, revealed_by: S, why_it_matters: S, page: S }) },
    country_differences: { type: "array", items: CITED({ item: S, by_country: { type: "array", items: { type: "object", properties: { country: S, value: S }, required: ["country", "value"] } } }) },
    limits_and_features: { type: "array", items: CITED({ feature: S, value: S }) },
    signed_in_findings: { type: "array", items: CITED({ finding: S, screen: S }) },
    documents: { type: "array", items: { type: "object", properties: { title: S, url: S }, required: ["title", "url"] } },
    what_a_fetch_tool_misses: { type: "array", items: CITED({ text: S, because: S }) },
    gaps: { type: "array", items: S },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
  },
  required: ["headline", "summary", "pricing", "hidden_findings", "country_differences", "limits_and_features", "signed_in_findings", "documents", "what_a_fetch_tool_misses", "gaps", "confidence"],
};

/** The observations the model reads: everything hidden, interior and borders first, then the surface, deduplicated and capped. */
export function selectForBrief(observations: Observation[], cap = 900): Observation[] {
  const rank = (o: Observation) => (o.layer === "hidden" ? 0 : o.layer === "interior" ? 1 : o.layer === "borders" ? 2 : 3);
  const seen = new Set<string>();
  return [...observations]
    .filter((o) => o.source !== "benchmark_fetch" && o.kind !== "link" && o.text.trim().length >= 3)
    .sort((a, b) => rank(a) - rank(b))
    .filter((o) => { const k = `${o.url}|${o.vantage.country ?? ""}|${o.text}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, cap);
}

/** Screenshots of the pages that hid the most: what the model gets to look at. */
export function pickScreenshots(observations: Observation[], max = 4): string[] {
  const perPage = new Map<string, { path: string; n: number }>();
  for (const o of observations) {
    if (o.layer !== "hidden" || !o.screenshotPath) continue;
    const cur = perPage.get(o.url);
    if (!cur) perPage.set(o.url, { path: o.screenshotPath, n: 1 }); else cur.n += 1;
  }
  return [...perPage.values()].sort((a, b) => b.n - a.n).map((p) => p.path).filter((p) => existsSync(p)).slice(0, max);
}

export function toImageBlocks(paths: string[]): Array<{ mediaType: "image/png" | "image/jpeg"; data: string }> {
  return paths.map((p) => ({ mediaType: p.toLowerCase().endsWith(".jpg") || p.toLowerCase().endsWith(".jpeg") ? "image/jpeg" as const : "image/png" as const, data: readFileSync(p).toString("base64") }));
}

/** Runs launched together share a stamp (helix-parse-1234, helix-borders-1234, helix-login-1234): the brief reads all of them. */
export function siblingRunIds(storage: Storage, runId: string): string[] {
  const m = runId.match(/^([a-z0-9]+)-(parse|borders|login)-(\d+)$/i);
  if (!m) return [runId];
  const [, family, , stamp] = m;
  return storage.listRuns(500).map((r) => r.id).filter((id) => id === runId || new RegExp(`^${family}-(parse|borders|login)-${stamp}$`, "i").test(id));
}

const HASH = /\s*\[[0-9a-f]{16,}\]/g;
const clean = (t: string) => t.replace(HASH, "").replace(/\s+([.,;])/g, "$1").trim();

export async function buildBrief(opts: { storage: Storage; runId: string; complete: Complete; model?: string; cap?: number; screenshots?: number }): Promise<Brief> {
  const { storage, runId } = opts;
  const runIds = siblingRunIds(storage, runId);
  const all = runIds.flatMap((id) => storage.getObservationsByRun(id));
  const picked = selectForBrief(all, opts.cap);
  const byId = new Map(all.map((o) => [o.id, o]));
  const competitor = [...new Set(all.map((o) => o.competitor))].join(", ") || storage.getRun(runId)?.goal || runId;

  const cov = coverage(runId, all); // observations from every sibling run, so the countries and the login walk land in one brief
  const pagesLine = cov.pages.map((p) => `${p.url} · fetch saw ${p.surface} · revealed ${p.hidden} · missed by fetch ${p.missedByFetch}${p.documents ? ` · documents ${p.documents}` : ""}`).join("\n");
  const bordersObs = all.filter((o) => o.layer === "borders");
  const grids = [...new Set(bordersObs.map((o) => o.url))].map((u) => bordersGrid(u, bordersObs));
  const gridLine = grids.map((g) => `${g.url} · differs by country: ${g.differsByCountry ? "yes" : "no"}\n` + g.countries.map((c) => `  ${c.country}: ${c.prices.slice(0, 8).join(" | ")}`).join("\n")).join("\n") || "(no country comparison in this run)";
  const prices = priceRows(all).slice(0, 80).map((r) => `[${r.observationId}] ${r.country ?? "home"} ${r.device}: ${r.amount} ${r.currency ?? ""} ${r.period ?? ""} — ${r.text.slice(0, 100)}`).join("\n") || "(no price lines)";
  const docs = all.filter((o) => o.kind === "document").slice(0, 40).map((o) => `[${o.id}] ${o.text}`).join("\n") || "(none)";
  const lines = picked.map((o) => `[${o.id}] (${o.layer}${o.vantage.country ? " " + o.vantage.country : ""}${o.vantage.authenticated ? " signed-in" : ""}${o.revealedBy?.label ? " via " + o.revealedBy.action + ":" + o.revealedBy.label : ""}) ${o.url.replace(/^https?:\/\/(www\.)?/, "")} :: ${o.text.slice(0, 220)}`).join("\n");
  const shots = toImageBlocks(pickScreenshots(all, opts.screenshots ?? 4));

  const system = [
    "You are the analyst behind Periscope, a competitive-intelligence tool. Real browsers opened every page of a competitor's site, clicked every toggle, dropdown, menu and expander, opened the same pages from several countries, and (when a person signed in) walked the signed-in screens.",
    "You get every observation with its id in brackets, the per-page coverage, the country grid, the parsed price lines, the document links, and screenshots of the pages that hid the most. Write the brief a head of product or a competitive analyst would want.",
    "Rules. Use only what the observations say; never invent a fact, a number, or an id. Every item in pricing, hidden_findings, country_differences, limits_and_features, signed_in_findings and what_a_fetch_tool_misses must cite the ids that support it (1 to 5).",
    "hidden_findings are facts that only appeared after an action (layer hidden or interior, or 'via' an action) — the things a scraper or a fetch-based AI tool would never see; say which action revealed each and why a competitor analyst cares.",
    "country_differences only when the same item shows different values from different countries. what_a_fetch_tool_misses: 3 to 8 concrete examples of content a fetch tool never returned, each with the reason (behind a toggle, rendered by the browser, country-specific, behind a login).",
    "Screenshots: use them to catch what text alone loses (tables, badges, strike-through prices, plan columns), but still cite the observation ids for anything you state. gaps: what could not be determined and why (no pricing page, login not done, page blocked). Be concrete, short, and specific: plan names, numbers, currencies, limits.",
  ].join(" ");
  const user = [
    `Competitor: ${competitor}`,
    `Run: ${runId}`,
    `\nPages opened (${cov.pages.length}):\n${pagesLine || "(none)"}`,
    `\nCountry grid:\n${gridLine}`,
    `\nPrice lines:\n${prices}`,
    `\nDocuments:\n${docs}`,
    `\nObservations (${picked.length} of ${all.length}):\n${lines}`,
  ].join("\n");

  const { input, tokensIn, tokensOut } = await opts.complete({ system, user, toolName: "record_brief", schema: BRIEF_SCHEMA, maxTokens: 12_000, images: shots });
  const raw = (input ?? {}) as Partial<Brief>;
  const keep = <T extends Cited>(items: unknown): T[] => (Array.isArray(items) ? items : [])
    .map((it) => ({ ...(it as T), evidenceIds: Array.isArray((it as T).evidenceIds) ? (it as T).evidenceIds.filter((id) => typeof id === "string" && byId.has(id)).slice(0, 5) : [] }))
    .filter((it) => it.evidenceIds.length > 0);
  const strings = (v: unknown, max: number) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, max) : []);
  const docsKnown = new Set(all.filter((o) => o.kind === "document").map((o) => o.text));

  return {
    headline: typeof raw.headline === "string" ? clean(raw.headline).slice(0, 200) : `What ${competitor} shows, and what it hides`,
    summary: strings(raw.summary, 8).map(clean),
    pricing: keep(raw.pricing),
    hidden_findings: keep(raw.hidden_findings),
    country_differences: keep(raw.country_differences),
    limits_and_features: keep(raw.limits_and_features),
    signed_in_findings: keep(raw.signed_in_findings),
    documents: (Array.isArray(raw.documents) ? raw.documents : []).filter((d) => d && typeof d.url === "string" && docsKnown.has(d.url)).map((d) => ({ title: String(d.title ?? d.url).slice(0, 120), url: d.url })),
    what_a_fetch_tool_misses: keep(raw.what_a_fetch_tool_misses),
    gaps: strings(raw.gaps, 10).map(clean),
    confidence: raw.confidence === "high" || raw.confidence === "medium" || raw.confidence === "low" ? raw.confidence : "medium",
    model: opts.model ?? "",
    generatedAt: new Date().toISOString(),
    observationsRead: picked.length,
    screenshotsRead: shots.length,
    tokensIn,
    tokensOut,
  };
}
