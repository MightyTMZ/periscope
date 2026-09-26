import Steel from "steel-sdk";
import type { Observation, Vantage, EventSink } from "@periscope/contracts";
import { createObservation } from "./utils/observation-factory.js";
import { splitBlocks, deduplicateNav } from "./utils/text.js";

export interface SurfaceResult {
  observations: Observation[];
  rawHtml: string;
  rawMarkdown: string;
}

/**
 * Stateless scrape baseline via Steel's scrape API.
 * No browser session needed. Source: "steel_scrape".
 */
export async function scrapeSurface(params: {
  steel: Steel;
  url: string;
  competitor: string;
  runId: string;
  jobId: string;
  vantage: Vantage;
  sink: EventSink;
}): Promise<SurfaceResult> {
  // Live finding (Fahad, Sept 13): on Framer/JS-heavy sites such as ornn.com "readability" comes back nearly empty
  // (15 chars) while "markdown" is complete (2.6k chars), so markdown is the block source; html is kept as the raw
  // artifact for the B6 raw-source proof. Both formats verified live on the same URL.
  const response = await scrapeWithRetry(params.steel, params.url);

  const rawHtml = (response as any).content?.html ?? "";
  const rawMarkdown = (response as any).content?.markdown ?? (response as any).content?.readability ?? "";

  // Parse into text blocks, deduplicate nav
  const blocks = deduplicateNav(splitBlocks(rawMarkdown || rawHtml));

  const observations: Observation[] = [];

  for (const block of blocks) {
    if (block.length < 3) continue;

    const obs = createObservation({
      runId: params.runId,
      jobId: params.jobId,
      competitor: params.competitor,
      url: params.url,
      layer: "surface",
      source: "steel_scrape",
      kind: "text",
      text: block,
      vantage: params.vantage,
      perception: "dom",
    });

    observations.push(obs);

    await params.sink.write({ type: "observation", data: obs });
  }

  return { observations, rawHtml, rawMarkdown };
}

/**
 * Steel's scrape endpoint opens a short-lived session that counts against the plan's concurrent limit (10 on Launch).
 * When the browsers are all busy it answers 429; waiting a few seconds and trying again is the right response, not a
 * failed page. Six tries over about a minute, then the error surfaces as before.
 */
async function scrapeWithRetry(steel: Steel, url: string): Promise<unknown> {
  let delay = 4000;
  for (let attempt = 1; ; attempt++) {
    try {
      return await steel.scrape({ url, format: ["markdown", "html"] });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const limit = /429|concurrent session limit/i.test(msg);
      if (!limit || attempt >= 6) throw err;
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 1.6, 20_000);
    }
  }
}
