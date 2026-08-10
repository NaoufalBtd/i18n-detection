import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Finding } from './types.js';

export interface CacheEntry {
  mtimeMs: number;
  findings: Finding[];
  suppressions: {
    totalCount: number;
    withoutReasonCount: number;
  };
}

export interface ScanCache {
  version: string;
  files: Record<string, CacheEntry>;
}

const CACHE_VERSION = '1.0';

export class CacheManager {
  private cachePath: string;
  private cache: ScanCache;

  constructor(projectRoot: string) {
    this.cachePath = path.join(projectRoot, '.i18n-scan-cache.json');
    this.cache = this.load();
  }

  private load(): ScanCache {
    if (fs.existsSync(this.cachePath)) {
      try {
        const content = fs.readFileSync(this.cachePath, 'utf8');
        const parsed = JSON.parse(content);
        if (parsed && parsed.version === CACHE_VERSION && parsed.files) {
          return parsed as ScanCache;
        }
      } catch (e) {
        // Corrupt cache or old format, ignore and start fresh
      }
    }
    return { version: CACHE_VERSION, files: {} };
  }

  public getEntry(relativePath: string, mtimeMs: number): CacheEntry | undefined {
    const entry = this.cache.files[relativePath];
    if (entry && entry.mtimeMs === mtimeMs) {
      return entry;
    }
    return undefined;
  }

  public setEntry(relativePath: string, mtimeMs: number, findings: Finding[], suppressions: { totalCount: number; withoutReasonCount: number }): void {
    this.cache.files[relativePath] = {
      mtimeMs,
      findings,
      suppressions
    };
  }

  public save(): void {
    try {
      fs.writeFileSync(this.cachePath, JSON.stringify(this.cache, null, 2), 'utf8');
    } catch (e: any) {
      console.warn(`Warning: Failed to write scan cache to ${this.cachePath}. Error: ${e.message}`);
    }
  }

  public clear(): void {
    if (fs.existsSync(this.cachePath)) {
      try {
        fs.unlinkSync(this.cachePath);
      } catch (e) {}
    }
    this.cache = { version: CACHE_VERSION, files: {} };
  }
}
