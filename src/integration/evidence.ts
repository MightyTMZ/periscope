import path from "node:path";
import { readFile } from "node:fs/promises";
import { ArtifactStore, type Storage } from "@periscope/knowledge";
import type { Event, EventSink, SessionHandle } from "@periscope/contracts";
import type { SteelAdapter } from "../steel/steel-adapter.js";

export const evidenceRoot = () => path.resolve(process.env.PERISCOPE_DATA_DIR ?? "data", "artifacts");

/** Persist screenshot blobs and their observation links before emitting the observation. */
export function evidenceSink(storage: Storage, sink: EventSink): EventSink {
  const artifacts = new ArtifactStore({ storage, root: evidenceRoot() });
  // A second copy of every screenshot in the artifact store doubled disk use and filled the volume. The screenshot
  // already lives under /screenshots with its path on the observation, so archive the blob only when explicitly asked.
  const archiveShots = process.env.PERISCOPE_ARCHIVE_SCREENSHOTS === "1";
  return { async write(event: Event) {
    if (archiveShots && event.type === "observation" && event.data.screenshotPath) {
      try {
        const ref = await artifacts.putBytes(await readFile(event.data.screenshotPath), { runId: event.data.runId, kind: "screenshot", mediaType: "image/png" });
        await sink.write(event);
        storage.linkArtifact(event.data.id, ref.id);
        return;
      } catch { /* fall through to a plain write */ }
    }
    await sink.write(event);
  } };
}

/** Keep session exports after release and attach them to every observation from that session. */
export async function archiveSession(storage: Storage, adapter: SteelAdapter, runId: string, handle: SessionHandle): Promise<void> {
  const artifacts = new ArtifactStore({ storage, root: evidenceRoot() });
  const refs: string[] = [];
  const errors: string[] = [];
  try {
    const trace = await adapter.exportTrace(handle.sessionId);
    const ref = await artifacts.putBytes(Buffer.from(JSON.stringify(trace)), { runId, kind: "trace", mediaType: "application/json" });
    refs.push(ref.id);
    if (!trace.complete) errors.push("Trace export is incomplete; Steel returned additional pages");
  } catch { errors.push("Trace export unavailable"); }
  try {
    for (const file of (await adapter.listFiles(handle.sessionId)).slice(0, 30)) {
      if ((file.size ?? 0) > 20 * 1024 * 1024) { errors.push(`File exceeds 20 MB limit: ${file.path}`); continue; }
      const bytes = await adapter.downloadFile(handle.sessionId, file.path);
      const ref = await artifacts.putBytes(bytes, { runId, kind: "document", mediaType: "application/octet-stream" });
      refs.push(ref.id);
    }
  } catch { errors.push("Session files unavailable"); }
  if (errors.length) {
    const ref = await artifacts.putBytes(Buffer.from(JSON.stringify({ sessionId: handle.sessionId, errors })), { runId, kind: "evidence_status", mediaType: "application/json" });
    refs.push(ref.id);
  }
  for (const obs of storage.getObservationsByRun(runId).filter((o) => o.steelSessionId === handle.sessionId)) {
    for (const id of refs) storage.linkArtifact(obs.id, id);
  }
}
