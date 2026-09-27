import { randomUUID } from "node:crypto";
import type { Storage } from "@periscope/knowledge";
import type { Complete } from "./extract.js";
import { BudgetExceededError, Meter } from "../meter.js";

const queues = new WeakMap<Storage, Promise<unknown>>();

/** Serialize model calls across runs; reserve a conservative token bound before dispatch. */
export function meteredCompletion(storage: Storage, runId: string, complete: Complete): Complete {
  return (args) => {
    const perform = async () => {
      const run = storage.getRun(runId);
      if (!run || run.status === "cancelled") throw new Error("Run unavailable or cancelled");
      const inputBound = Buffer.byteLength(args.system + args.user + JSON.stringify(args.schema), "utf8") + 2048 + (args.images?.length ?? 0) * 6000; // ~1.5k tokens per screenshot
      const reserved = Meter.tokensToUsd(inputBound, args.maxTokens);
      const spent = storage.runSpendMicroUsd(runId) / 1e6;
      const cap = run.capMicroUsd / 1e6;
      const total = storage.listRuns(100000).reduce((n, r) => n + storage.runSpendMicroUsd(r.id) / 1e6, 0);
      const totalCap = Number(process.env.PERISCOPE_TOTAL_BUDGET_USD ?? 75);
      if (spent + reserved > cap || total + reserved > totalCap) {
        throw new BudgetExceededError("run", spent + reserved, Math.min(cap, totalCap - total + spent));
      }
      const id = `model-${randomUUID()}`;
      storage.createJob({ id, runId, purpose: "reveal", state: "running" });
      try {
        const result = await complete(args);
        storage.write({ type: "receipt", data: { jobId: id, step: 1, action: args.toolName, before: "", after: "Structured result received", ok: true, tokensIn: result.tokensIn, tokensOut: result.tokensOut, usd: Meter.tokensToUsd(result.tokensIn, result.tokensOut) } }, { runId, jobId: id });
        storage.write({ type: "job_state", data: { jobId: id, state: "completed" } }, { runId, jobId: id });
        storage.write({ type: "spend", data: { runId, usd: storage.runSpendMicroUsd(runId) / 1e6, cap } }, { runId });
        return result;
      } catch (error) {
        storage.write({ type: "job_state", data: { jobId: id, state: "failed", reason: "Model request failed" } }, { runId, jobId: id });
        throw error;
      }
    };
    const next = (queues.get(storage) ?? Promise.resolve()).catch(() => undefined).then(perform);
    queues.set(storage, next);
    return next;
  };
}
