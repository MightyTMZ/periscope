// The data volume is finite. Screenshots are the only thing that grows without bound (one per capture, thousands per
// whole-site run), so they are the only thing swept: oldest first, until the folder is under its cap. Observations keep
// their screenshotPath; a swept path simply no longer resolves, the same as a screenshot that failed to save.
import { readdirSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";

function dirBytes(dir: string): Array<{ p: string; size: number; mtime: number }> {
  const out: Array<{ p: string; size: number; mtime: number }> = [];
  let entries: string[] = [];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e);
    let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) out.push(...dirBytes(p)); else out.push({ p, size: st.size, mtime: st.mtimeMs });
  }
  return out;
}

/** Keep a folder (files, recursively) under a byte cap, deleting oldest first. */
function sweepDir(dir: string, maxBytes: number): { before: number; after: number; removed: number } {
  const files = dirBytes(dir);
  const before = files.reduce((n, f) => n + f.size, 0);
  let total = before; let removed = 0;
  for (const f of files.sort((a, b) => a.mtime - b.mtime)) {
    if (total <= maxBytes) break;
    try { unlinkSync(f.p); total -= f.size; removed += 1; } catch { /* already gone */ }
  }
  return { before, after: total, removed };
}

export function sweepScreenshots(dataDir = process.env.PERISCOPE_DATA_DIR ?? "./data", maxBytes = Number(process.env.PERISCOPE_SCREENSHOT_CAP_MB ?? 600) * 1024 * 1024): { before: number; after: number; removed: number } {
  // both places evidence lands: /screenshots (the live captures) and /artifacts (blobs + session traces)
  const shots = sweepDir(path.resolve(dataDir, "screenshots"), maxBytes);
  const arts = sweepDir(path.resolve(dataDir, "artifacts"), Number(process.env.PERISCOPE_ARTIFACT_CAP_MB ?? 200) * 1024 * 1024);
  return { before: shots.before + arts.before, after: shots.after + arts.after, removed: shots.removed + arts.removed };
}
