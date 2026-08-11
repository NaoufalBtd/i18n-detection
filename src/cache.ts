import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { Finding, ScannerConfig } from './types.js';
import { CACHE_SCHEMA_VERSION, TOOL_VERSION } from './version.js';
import { writeFilesAtomically } from './io.js';

export interface CacheEntry {
  contentHash: string;
  findings: Finding[];
  suppressions: {
    totalCount: number;
    withoutReasonCount: number;
  };
}

export interface ScanCache {
  version: string;
  engineVersion: string;
  configHash: string;
  files: Record<string, CacheEntry>;
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, val]) => `${JSON.stringify(key)}:${stableSerialize(val)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export function hashConfig(config: ScannerConfig): string {
  return createHash('sha256').update(stableSerialize(config)).digest('hex');
}

export class CacheManager {
  private readonly cachePath: string;
  private readonly configHash: string;
  private cache: ScanCache;

  constructor(projectRoot: string, config: ScannerConfig) {
    this.cachePath = path.join(projectRoot, '.i18n-scan-cache.json');
    this.configHash = hashConfig(config);
    this.cache = this.load();
  }

  private empty(): ScanCache {
    return {
      version: CACHE_SCHEMA_VERSION,
      engineVersion: TOOL_VERSION,
      configHash: this.configHash,
      files: {}
    };
  }

  private load(): ScanCache {
    if (!fs.existsSync(this.cachePath)) return this.empty();

    try {
      const parsed = JSON.parse(fs.readFileSync(this.cachePath, 'utf8')) as Partial<ScanCache>;
      if (
        parsed.version === CACHE_SCHEMA_VERSION &&
        parsed.engineVersion === TOOL_VERSION &&
        parsed.configHash === this.configHash &&
        parsed.files &&
        typeof parsed.files === 'object'
      ) {
        return parsed as ScanCache;
      }
    } catch {
      // Corrupt or incompatible caches are intentionally discarded.
    }
    return this.empty();
  }

  public getEntry(relativePath: string, contentHash: string): CacheEntry | undefined {
    const entry = this.cache.files[relativePath];
    return entry?.contentHash === contentHash ? entry : undefined;
  }

  public setEntry(
    relativePath: string,
    contentHash: string,
    findings: Finding[],
    suppressions: { totalCount: number; withoutReasonCount: number }
  ): void {
    this.cache.files[relativePath] = { contentHash, findings, suppressions };
  }

  public save(): void {
    try {
      writeFilesAtomically([
        {
          filePath: this.cachePath,
          content: `${JSON.stringify(this.cache, null, 2)}\n`
        }
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Warning: Failed to write scan cache to ${this.cachePath}. Error: ${message}`);
    }
  }

  public clear(): void {
    try {
      if (fs.existsSync(this.cachePath)) fs.unlinkSync(this.cachePath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to clear scan cache at ${this.cachePath}: ${message}`);
    }
    this.cache = this.empty();
  }
}
