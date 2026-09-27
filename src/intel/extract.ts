// Feature matrix and diff summary with Claude (section 8.2). Every row carries observation ids; a row without
// evidence is rejected; a visible control is `observed`, never `verified_working` (A10, A11). The model is behind a
// small `complete` function so tests run with a fake and the API can run without a key.
import { readFileSync } from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import type { Storage, FindingRecord } from "@periscope/knowledge";
import type { Observation } from "@periscope/contracts";
import type { RunDiff } from "./diff.js";

export interface ExtractedRow {
  feature: string;
  status: "observed" | "absent" | "unknown";
  value: string | null;
  evidenceIds: string[];
}

export interface Completion { rows?: ExtractedRow[]; bullets?: string[]; tokensIn: number; tokensOut: number }
/** One model call, forced onto a tool with `schema`; returns the tool input and token usage. */
export interface CompleteImage { mediaType: "image/png" | "image/jpeg"; data: string }
export type Complete = (args: { system: string; user: string; toolName: string; schema: Record<string, unknown>; maxTokens: number; images?: CompleteImage[]; model?: string }) => Promise<{ input: unknown; tokensIn: number; tokensOut: number }>;

/** Bulk model (extraction, navigation). PERISCOPE_MODEL overrides; the brief uses PERISCOPE_BRIEF_MODEL (see below). */
export const DEFAULT_MODEL = process.env.PERISCOPE_MODEL ?? "claude-sonnet-5";
/** The brief is one call per run and is what people read: the strongest model by default. */
export const BRIEF_MODEL = process.env.PERISCOPE_BRIEF_MODEL ?? process.env.PERISCOPE_MODEL ?? "claude-opus-5-5";

/** Real model behind the same interface. Needs ANTHROPIC_API_KEY. Screenshots go in as image blocks before the text. */
export function anthropicComplete(model = DEFAULT_MODEL): Complete {
  const client = new Anthropic();
  return async ({ system, user, toolName, schema, maxTokens, images, model: override }) => {
    const content: Anthropic.MessageParam["content"] = [
      ...(images ?? []).map((im) => ({ type: "image" as const, source: { type: "base64" as const, media_type: im.mediaType, data: im.data } })),
      { type: "text" as const, text: user },
    ];
    const res = await client.messages.create({
      model: override ?? model, max_tokens: maxTokens, system,
      messages: [{ role: "user", content }],
      tools: [{ name: toolName, description: "Record the structured result.", input_schema: schema as Anthropic.Tool["input_schema"] }],
      tool_choice: { type: "tool", name: toolName },
    });
    const block = res.content.find((b) => b.type === "tool_use");
    return { input: block && block.type === "tool_use" ? block.input : {}, tokensIn: res.usage.input_tokens, tokensOut: res.usage.output_tokens };
  };
}

export function loadTaxonomy(category: string): string[] {
  const p = path.join("taxonomy", `${category}.json`);
  try { return (JSON.parse(readFileSync(p, "utf8")) as { features: string[] }).features; }
  catch { return (JSON.parse(readFileSync(path.join("taxonomy", "saas.json"), "utf8")) as { features: string[] }).features; }
}

const ROWS_SCHEMA = {
  type: "object",
  properties: {
    rows: {
      type: "array",
      items: {
        type: "object",
        properties: {
          feature: { type: "string" },
          status: { type: "string", enum: ["observed", "absent", "unknown"] },
          value: { type: ["string", "null"] },
          evidenceIds: { type: "array", items: { type: "string" } },
        },
        required: ["feature", "status", "value", "evidenceIds"],
      },
    },
  },
  required: ["rows"],
};

/** Pick the observations worth the model's attention: hidden, borders and interior first, then surface, capped. */
export function selectForExtraction(observations: Observation[], cap = 350): Observation[] {
  const rank = (o: Observation) => (o.layer === "hidden" ? 0 : o.layer === "interior" ? 1 : o.layer === "borders" ? 2 : 3);
  const seen = new Set<string>();
  return [...observations]
    .filter((o) => o.source !== "benchmark_fetch" && o.kind !== "link")
    .sort((a, b) => rank(a) - rank(b))
    .filter((o) => { const k = `${o.url}|${o.text}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, cap);
}

export interface ExtractResult { rows: ExtractedRow[]; rejected: number; findings: FindingRecord[]; tokensIn: number; tokensOut: number }

/**
 * Extract the feature matrix for one competitor in a run and persist findings of kind `feature`.
 * Rows are validated in code, not trusted from the model: unknown features, missing or unknown evidence ids and
 * any status outside observed/absent/unknown are dropped and counted in `rejected`.
 */
export async function extractFeatures(opts: { storage: Storage; runId: string; competitor: string; category?: string; complete: Complete; taxonomy?: string[]; cap?: number }): Promise<ExtractResult> {
  const { storage, runId, competitor } = opts;
  const taxonomy = opts.taxonomy ?? loadTaxonomy(opts.category ?? storage.getRun(runId)?.category ?? "saas");
  const all = storage.getObservationsByRun(runId, { competitor });
  const picked = selectForExtraction(all, opts.cap);
  if (picked.length === 0) return { rows: [], rejected: 0, findings: [], tokensIn: 0, tokensOut: 0 };
  const byId = new Map(all.map((o) => [o.id, o]));
  const lines = picked.map((o) => `[${o.id}] (${o.layer}${o.vantage.country ? " " + o.vantage.country : ""}${o.revealedBy?.label ? " via " + o.revealedBy.label : ""}) ${o.text.slice(0, 240)}`).join("\n");
  const system = [
    "You build a competitor feature matrix from web observations. Each observation line starts with its id in brackets.",
    "Rules: use only features from the taxonomy, spelled exactly. status is 'observed' when at least one observation shows the feature exists or is mentioned as available,",
    "'absent' only when an observation states it is not offered, otherwise 'unknown'. Never claim a feature works; you only saw it mentioned.",
    "value is the concrete detail (a price, a limit, a plan name) copied from the observations, or null. evidenceIds must list the ids of the observations that support the row.",
    "Do not invent ids. Omit taxonomy features with no relevant observation entirely; do not emit 'unknown' rows. List at most 5 evidence ids per row and keep value under 120 characters.",
  ].join(" ");
  const user = `Competitor: ${competitor}\nTaxonomy: ${taxonomy.join(" | ")}\n\nObservations:\n${lines}`;
  const { input, tokensIn, tokensOut } = await opts.complete({ system, user, toolName: "record_features", schema: ROWS_SCHEMA, maxTokens: 8000 });

  const raw = ((input as { rows?: unknown }).rows ?? []) as Array<Partial<ExtractedRow>>;
  const rows: ExtractedRow[] = []; let rejected = 0;
  const taxonomySet = new Set(taxonomy.map((t) => t.toLowerCase()));
  for (const r of raw) {
    const feature = typeof r.feature === "string" ? taxonomy.find((t) => t.toLowerCase() === r.feature!.toLowerCase()) : undefined;
    const status = r.status === "observed" || r.status === "absent" || r.status === "unknown" ? r.status : undefined;
    const evidenceIds = Array.isArray(r.evidenceIds) ? r.evidenceIds.filter((id): id is string => typeof id === "string" && byId.has(id)) : [];
    if (!feature || !status || !taxonomySet.has(feature.toLowerCase())) { rejected++; continue; }
    if (status !== "unknown" && evidenceIds.length === 0) { rejected++; continue; } // no evidence, no claim
    if (rows.some((x) => x.feature === feature)) { rejected++; continue; }
    rows.push({ feature, status, value: typeof r.value === "string" ? r.value.slice(0, 300) : null, evidenceIds });
  }

  const findings: FindingRecord[] = [];
  for (const row of rows) {
    if (row.status === "unknown") continue; // an unknown row is not a finding, it is the absence of one
    const id = `feature:${runId}:${competitor}:${row.feature.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
    if (storage.getFinding(id)) { findings.push(storage.getFinding(id)!); continue; }
    findings.push(storage.createFinding({ id, runId, competitor, kind: "feature", title: row.feature, status: "observed", value: row.status === "absent" ? `absent: ${row.value ?? ""}`.trim() : row.value ?? undefined, observationIds: row.evidenceIds, metadata: { extractedStatus: row.status } }));
  }
  return { rows, rejected, findings, tokensIn, tokensOut };
}

const BULLETS_SCHEMA = { type: "object", properties: { bullets: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 5 } }, required: ["bullets"] };

/** Five-bullet summary of a run-to-run diff. Prices and removals first. */
export async function summarizeDiff(diff: RunDiff, complete: Complete): Promise<{ bullets: string[]; tokensIn: number; tokensOut: number }> {
  if (diff.added.length + diff.removed.length === 0) return { bullets: ["No change between the two runs."], tokensIn: 0, tokensOut: 0 };
  const fmt = (l: { vantage: string; text: string }) => `[${l.vantage}] ${l.text.slice(0, 200)}`;
  const user = `Run ${diff.fromRunId} -> ${diff.toRunId}. Unchanged lines: ${diff.unchanged}.\n\nNew price lines:\n${diff.priceChanges.map(fmt).join("\n") || "(none)"}\n\nAdded:\n${diff.added.slice(0, 120).map(fmt).join("\n") || "(none)"}\n\nRemoved:\n${diff.removed.slice(0, 120).map(fmt).join("\n") || "(none)"}`;
  const { input, tokensIn, tokensOut } = await complete({
    system: "You summarise what changed on a competitor's website between two crawls for a product manager. At most five bullets, each one sentence, concrete, quoting prices and plan names. Say 'scroll or layout noise' for lines that only moved. Never invent a change that is not in the lists.",
    user, toolName: "record_summary", schema: BULLETS_SCHEMA, maxTokens: 600,
  });
  const bullets = (((input as { bullets?: unknown }).bullets ?? []) as unknown[]).filter((b): b is string => typeof b === "string").slice(0, 5);
  return { bullets: bullets.length ? bullets : ["The model returned no summary."], tokensIn, tokensOut };
}
