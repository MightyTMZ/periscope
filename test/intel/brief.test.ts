// The brief: evidence ids are checked in code; invented ids are dropped, and an item with no surviving evidence goes with them.
import { describe, expect, it } from "vitest";
import { Storage } from "@periscope/knowledge";
import type { Observation } from "@periscope/contracts";
import { StorageSink } from "../../src/integration/storage-sink.js";
import { buildBrief, selectForBrief } from "../../src/intel/brief.js";
import type { Complete } from "../../src/intel/extract.js";
import { planSite } from "../../src/intel/navigator.js";

function fresh() { const s = Storage.open({ path: ":memory:" }); s.migrate(); return s; }
const obs = (runId: string, competitor: string, text: string, over: Partial<Observation> = {}): Observation => ({
  id: `${runId}/${competitor}/${text}`, runId, jobId: `${runId}-${competitor}`, competitor, url: `https://${competitor}.test/pricing`,
  layer: "hidden", source: "browser", kind: "text", text, vantage: { country: null, device: "desktop", authenticated: false },
  perception: "dom", revealedBy: { action: "toggle", label: "Annual" }, missedByFetch: true, capturedAt: new Date().toISOString(), ...over,
});

describe("brief", () => {
  it("keeps only claims backed by real observation ids and reports what it read", async () => {
    const storage = fresh();
    storage.createRun({ id: "r1", goal: "acme", category: "saas", capUsd: 5, status: "completed" });
    const sink = new StorageSink({ storage, runId: "r1", jobHints: () => ({ purpose: "reveal", competitor: "acme" }) });
    await sink.write({ type: "observation", data: obs("r1", "acme", "CA$26 per user per month billed annually") });
    await sink.write({ type: "observation", data: obs("r1", "acme", "Team plan: 25 of 30 seats used", { layer: "interior", vantage: { country: null, device: "desktop", authenticated: true } }) });
    await sink.write({ type: "observation", data: obs("r1", "acme", "https://acme.test/whitepaper.pdf", { kind: "document" }) });
    let seenIds: string[] = [];
    const complete: Complete = async ({ user, images }) => {
      seenIds = [...user.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]);
      expect(images ?? []).toEqual([]); // no screenshots on disk in tests
      return { tokensIn: 10, tokensOut: 5, input: {
        headline: "Acme hides its annual price",
        summary: ["Annual billing is 20% cheaper", "Seats are capped at 30 on Team"],
        pricing: [
          { plan: "Team", price: "CA$26", period: "month", currency: "CAD", country: "CA", note: "annual", evidenceIds: ["r1/acme/CA$26 per user per month billed annually"] },
          { plan: "Ghost", price: "$1", period: null, currency: null, country: null, note: null, evidenceIds: ["made-up-id"] },
        ],
        hidden_findings: [{ finding: "Annual price only after the toggle", revealed_by: "toggle: Annual", why_it_matters: "list price is 20% higher", page: "/pricing", evidenceIds: ["r1/acme/CA$26 per user per month billed annually", "nope"] }],
        country_differences: [],
        limits_and_features: [],
        signed_in_findings: [{ finding: "30-seat cap on Team", screen: "billing", evidenceIds: ["r1/acme/Team plan: 25 of 30 seats used"] }],
        documents: [{ title: "Whitepaper", url: "https://acme.test/whitepaper.pdf" }, { title: "Fake", url: "https://acme.test/nope.pdf" }],
        what_a_fetch_tool_misses: [{ text: "CA$26 annual", because: "behind a toggle", evidenceIds: ["r1/acme/CA$26 per user per month billed annually"] }],
        gaps: ["No enterprise price shown"],
        confidence: "medium",
      } };
    };
    const b = await buildBrief({ storage, runId: "r1", complete, model: "fake" });
    expect(seenIds.length).toBeGreaterThanOrEqual(3);
    expect(b.pricing.map((p) => p.plan)).toEqual(["Team"]);            // the ghost row had no real evidence
    expect(b.hidden_findings[0].evidenceIds).toEqual(["r1/acme/CA$26 per user per month billed annually"]); // the invented id is gone
    expect(b.signed_in_findings.length).toBe(1);
    expect(b.documents.map((d) => d.url)).toEqual(["https://acme.test/whitepaper.pdf"]);
    expect(b.observationsRead).toBe(3);
    expect(b.confidence).toBe("medium");
  });

  it("selects hidden and interior lines before surface and drops fetch benchmark lines", () => {
    const lines = [obs("r", "a", "surface line", { layer: "surface" }), obs("r", "a", "hidden line"), obs("r", "a", "benchmark line", { source: "benchmark_fetch" }), obs("r", "a", "interior line", { layer: "interior" })];
    expect(selectForBrief(lines).map((o) => o.text)).toEqual(["hidden line", "interior line", "surface line"]);
  });
});

describe("navigator", () => {
  it("orders known urls by the model's priority and ignores urls it invents", async () => {
    const urls = ["https://a.test/", "https://a.test/blog/x", "https://a.test/pricing", "https://a.test/docs"];
    const complete: Complete = async () => ({ tokensIn: 1, tokensOut: 1, input: { read: "Sells widgets, per-seat pricing.", pages: [
      { url: "https://a.test/pricing", type: "pricing", priority: 5 }, { url: "https://a.test/docs", type: "docs", priority: 4 },
      { url: "https://a.test/blog/x", type: "blog", priority: 1 }, { url: "https://a.test/made-up", type: "pricing", priority: 5 },
    ] } });
    const plan = await planSite({ competitor: "a", urls, complete });
    expect(plan.order).toEqual(["https://a.test/pricing", "https://a.test/docs", "https://a.test/", "https://a.test/blog/x"]);
    expect(plan.types.get("https://a.test/blog/x")).toBe("blog");
    expect(plan.types.has("https://a.test/made-up")).toBe(false);
    expect(plan.read).toContain("widgets");
  });
});
