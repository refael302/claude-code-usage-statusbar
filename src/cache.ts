import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { UsageSnapshot } from "./usageApi";

const CACHE_NAME = "claude-code-usage-statusbar-cache.json";

export interface SharedCache {
  fetchedAt: number;
  backoffUntil?: number;
  backoffMs?: number;
  snapshot?: UsageSnapshot;
  error?: string;
}

export function cachePath(): string {
  return path.join(os.tmpdir(), CACHE_NAME);
}

export function readCache(): SharedCache | null {
  try {
    const raw = fs.readFileSync(cachePath(), "utf8");
    return JSON.parse(raw) as SharedCache;
  } catch {
    return null;
  }
}

export function writeCache(cache: SharedCache): void {
  const filePath = cachePath();
  const tmp = `${filePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(cache), "utf8");
    fs.renameSync(tmp, filePath);
  } catch {
    try {
      fs.writeFileSync(filePath, JSON.stringify(cache), "utf8");
    } catch {
      // best-effort shared cache
    }
  }
}

export function isFresh(cache: SharedCache | null, ttlMs: number): boolean {
  if (!cache?.snapshot) {
    return false;
  }
  return Date.now() - cache.fetchedAt < ttlMs;
}

export function isInBackoff(cache: SharedCache | null): boolean {
  return !!cache?.backoffUntil && Date.now() < cache.backoffUntil;
}
