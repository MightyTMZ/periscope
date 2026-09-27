// The data volume is finite. Screenshots are the only thing that grows without bound (one per capture, thousands per
// whole-site run), so they are the only thing swept: oldest first, until the folder is under its cap. Observations keep
// their screenshotPath; a swept path simply no longer resolves, the same as a screenshot that failed to save.
import { readdirSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";

export function sweepScreenshots(dataDir = process.env.PERISCOPE_DATA_DIR ?? "./data", maxBytes = Number(process.env.PERISCOPE_SCREENSHOT_CAP_MB ?? 600) * 1024 * 1024): { before: number; after: number; removed: number } {
  const dir = path.resolve(dataDir, "screenshots");
  let files: Array<{ p: string; size: number; mtime: number }> = [];
  try {
    files = readdirSync(dir).map((f) => { const p = path.join(dir, f); const st = statSync(p); return { p, size: st.size, mtime: st.mtimeMs }; });
  } catch { return { before: 0, after: 0, removed: 0 }; }
  const before = files.reduce((n, f) => n + f.size, 0);
  let total = before; let removed = 0;
  for (const f of files.sort((a, b) => a.mtime - b.mtime)) {
    if (total <= maxBytes) break;
    try { unlinkSync(f.p); total -= f.size; removed += 1; } catch { /* already gone */ }
  }
  return { before, after: total, removed };
}
