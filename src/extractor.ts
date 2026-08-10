import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ScannerConfig, Finding } from './types.js';

export interface CollisionReport {
  existingMatches: { key: string; value: string; filePath: string }[];
  keyCollisions: { key: string; oldValue: string; newValue: string; filePath: string }[];
  similarValues: { key: string; value: string; existingKey: string; filePath: string }[];
  newEntries: { key: string; value: string; filePath: string }[];
}

function setPath(obj: any, pathStr: string, value: string): void {
  const parts = pathStr.split('.');
  let curr = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!(part in curr) || typeof curr[part] !== 'object') {
      curr[part] = {};
    }
    curr = curr[part];
  }
  curr[parts[parts.length - 1]] = value;
}

function flattenObject(obj: any, prefix = '', res: Record<string, string> = {}): Record<string, string> {
  if (!obj || typeof obj !== 'object') return res;
  for (const key of Object.keys(obj)) {
    const propName = prefix ? `${prefix}.${key}` : key;
    if (obj[key] && typeof obj[key] === 'object' && !Array.isArray(obj[key])) {
      flattenObject(obj[key], propName, res);
    } else {
      res[propName] = String(obj[key]);
    }
  }
  return res;
}

function unflattenObject(flat: Record<string, string>): any {
  const res = {};
  for (const [key, val] of Object.entries(flat)) {
    setPath(res, key, val);
  }
  return res;
}

export class Extractor {
  private config: ScannerConfig;
  private projectRoot: string;

  constructor(config: ScannerConfig, projectRoot = process.cwd()) {
    this.config = config;
    this.projectRoot = projectRoot;
  }

  public extractCatalog(findings: Finding[], merge = false, dryRun = false): CollisionReport {
    const messagesPath = path.resolve(this.projectRoot, this.config.i18n.messagesPath);
    let existingCatalog: Record<string, string> = {};

    if (fs.existsSync(messagesPath)) {
      try {
        const fileContent = fs.readFileSync(messagesPath, 'utf8');
        const parsed = JSON.parse(fileContent);
        if (this.config.i18n.catalogFormat === 'nested-json') {
          existingCatalog = flattenObject(parsed);
        } else {
          existingCatalog = parsed;
        }
      } catch (e: any) {
        console.warn(`Warning: Failed to parse existing catalog at ${messagesPath}. Starting fresh. Error: ${e.message}`);
      }
    }

    const report: CollisionReport = {
      existingMatches: [],
      keyCollisions: [],
      similarValues: [],
      newEntries: []
    };

    const newKeysToAdd: Record<string, string> = {};

    // Group active findings (exclude ignored)
    const activeFindings = findings.filter(f => f.confidence !== 'ignored');

    // Create value-to-keys reverse index for similar value check
    const valueToKeys: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(existingCatalog)) {
      const normV = v.trim();
      if (!valueToKeys[normV]) {
        valueToKeys[normV] = [];
      }
      valueToKeys[normV].push(k);
    }

    for (const f of activeFindings) {
      const textToExtract = f.texts && f.texts.length > 0
        ? f.texts[0]
        : (f.normalizedText || f.rawText || '');

      if (!textToExtract) continue;

      const suggestedKey = f.suggestedKey;
      if (!suggestedKey) continue;

      // 1. Key collision checks
      if (suggestedKey in existingCatalog) {
        const oldValue = existingCatalog[suggestedKey];
        if (oldValue === textToExtract) {
          report.existingMatches.push({
            key: suggestedKey,
            value: textToExtract,
            filePath: f.filePath
          });
          f.existingSimilarKey = suggestedKey;
        } else {
          report.keyCollisions.push({
            key: suggestedKey,
            oldValue,
            newValue: textToExtract,
            filePath: f.filePath
          });
        }
      } else {
        // 2. Similar value check
        const normalizedTextVal = textToExtract.trim();
        if (normalizedTextVal in valueToKeys) {
          const existingKey = valueToKeys[normalizedTextVal][0];
          report.similarValues.push({
            key: suggestedKey,
            value: textToExtract,
            existingKey,
            filePath: f.filePath
          });
          f.existingSimilarKey = existingKey;
        } else {
          // 3. New Entry
          report.newEntries.push({
            key: suggestedKey,
            value: textToExtract,
            filePath: f.filePath
          });
          newKeysToAdd[suggestedKey] = textToExtract;
        }
      }
    }

    if (merge && !dryRun && Object.keys(newKeysToAdd).length > 0) {
      const mergedCatalog = { ...existingCatalog, ...newKeysToAdd };
      let outputContent = '';

      if (this.config.i18n.catalogFormat === 'nested-json') {
        const nested = unflattenObject(mergedCatalog);
        outputContent = JSON.stringify(nested, null, 2) + '\n';
      } else {
        outputContent = JSON.stringify(mergedCatalog, null, 2) + '\n';
      }

      fs.mkdirSync(path.dirname(messagesPath), { recursive: true });
      fs.writeFileSync(messagesPath, outputContent, 'utf8');
    }

    return report;
  }
}
