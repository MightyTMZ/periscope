import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Page } from "playwright-core";

/**
 * Evidence stays local. Never send account/login screenshots to a model.
 * Viewport-sized JPEG, not a full-page PNG: a receipt of what was on screen at the click, at a fraction of the bytes.
 * (Full-page PNGs filled the hosted data volume within a day.)
 */
export async function saveScreenshot(page: Page): Promise<string | undefined> {
  try {
    const dir = path.resolve(process.env.PERISCOPE_DATA_DIR ?? "data", "screenshots");
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `${randomUUID()}.jpg`);
    await writeFile(file, await page.screenshot({ type: "jpeg", quality: 55, fullPage: false, timeout: 5000 }));
    return file;
  } catch { return undefined; }
}
