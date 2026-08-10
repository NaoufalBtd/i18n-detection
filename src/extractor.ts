import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ScannerConfig, Finding } from './types.js';
import { writeFilesAtomically } from './io.js';

export interface CatalogEntry {
  key: string;
  value: string;
  filePath: string;
  findingId?: string;
}

export interface CollisionReport {
  existingMatches: CatalogEntry[];
  keyCollisions: { key: string; oldValue: string; newValue: string; filePath: string; findingId?: string }[];
  similarValues: { key: string; value: string; existingKey: string; filePath: string; findingId?: string }[];
  newEntries: CatalogEntry[];
  blockedFindings: { findingId: string; filePath: string; reason: string }[];
}

export interface CatalogPlan {
  locale: string;
  catalogPath: string;
  report: CollisionReport;
  keyByFindingId: Record<string, string>;
  outputContent: string;
  changed: boolean;
}

function setPath(target: Record<string, unknown>, pathString: string, value: string): void {
  const parts = pathString.split('.');
  let current: Record<string, unknown> = target;
  for (let index = 0; index < parts.length - 1; index++) {
    const part = parts[index];
    const existing = current[part];
    if (existing === undefined) current[part] = {};
    else if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
      throw new Error(`Catalog key '${parts.slice(0, index + 1).join('.')}' is both a value and a namespace`);
    }
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
}

function flattenObject(
  value: unknown,
  prefix = '',
  result: Record<string, string> = {}
): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Nested translation catalog must contain a JSON object at its root');
  }

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const property = prefix ? `${prefix}.${key}` : key;
    if (typeof child === 'string') result[property] = child;
    else if (child && typeof child === 'object' && !Array.isArray(child)) flattenObject(child, property, result);
    else throw new Error(`Translation catalog value '${property}' must be a string or nested object`);
  }
  return result;
}

function validateFlatCatalog(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Flat translation catalog must contain a JSON object at its root');
  }
  const result: Record<string, string> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (typeof child !== 'string') throw new Error(`Flat translation catalog value '${key}' must be a string`);
    result[key] = child;
  }
  return result;
}

function unflattenObject(flat: Record<string, string>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(flat).sort(([a], [b]) => a.localeCompare(b))) {
    setPath(result, key, value);
  }
  return result;
}

export class Extractor {
  private readonly config: ScannerConfig;
  private readonly projectRoot: string;

  constructor(config: ScannerConfig, projectRoot = process.cwd()) {
    this.config = config;
    this.projectRoot = path.resolve(projectRoot);
  }

  public resolveCatalogPath(locale = this.config.i18n.sourceLocale): string {
    const configured = this.config.i18n.messagesPath;
    if (configured.includes('{locale}')) {
      return path.resolve(this.projectRoot, configured.replaceAll('{locale}', locale));
    }
    if (locale !== this.config.i18n.sourceLocale) {
      throw new Error(
        `i18n.messagesPath '${configured}' has no {locale} placeholder, so locale '${locale}' cannot be selected safely`
      );
    }
    return path.resolve(this.projectRoot, configured);
  }

  private readCatalog(catalogPath: string): Record<string, string> {
    if (!fs.existsSync(catalogPath)) return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(catalogPath, 'utf8')) as unknown;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to parse existing catalog at ${catalogPath}: ${message}`);
    }
    return this.config.i18n.catalogFormat === 'nested-json'
      ? flattenObject(parsed)
      : validateFlatCatalog(parsed);
  }

  private serializeCatalog(catalog: Record<string, string>): string {
    const sorted = Object.fromEntries(Object.entries(catalog).sort(([a], [b]) => a.localeCompare(b)));
    const output = this.config.i18n.catalogFormat === 'nested-json' ? unflattenObject(sorted) : sorted;
    return `${JSON.stringify(output, null, 2)}\n`;
  }

  public planCatalog(findings: Finding[], locale = this.config.i18n.sourceLocale): CatalogPlan {
    const catalogPath = this.resolveCatalogPath(locale);
    const existingCatalog = this.readCatalog(catalogPath);
    const report: CollisionReport = {
      existingMatches: [],
      keyCollisions: [],
      similarValues: [],
      newEntries: [],
      blockedFindings: []
    };
    const keyByFindingId: Record<string, string> = {};
    const plannedCatalog: Record<string, string> = { ...existingCatalog };
    const exactValueToKeys = new Map<string, string[]>();
    const normalizedValueToKeys = new Map<string, string[]>();

    for (const [key, value] of Object.entries(existingCatalog)) {
      exactValueToKeys.set(value, [...(exactValueToKeys.get(value) ?? []), key]);
      const normalized = value.trim();
      normalizedValueToKeys.set(normalized, [...(normalizedValueToKeys.get(normalized) ?? []), key]);
    }

    const activeFindings = findings
      .filter(finding => finding.confidence !== 'ignored')
      .sort((a, b) => a.filePath.localeCompare(b.filePath) || a.line - b.line || a.column - b.column);

    for (const finding of activeFindings) {
      if (finding.texts && finding.texts.length > 1) {
        report.blockedFindings.push({
          findingId: finding.id,
          filePath: finding.filePath,
          reason: 'Conditional finding contains multiple source strings and requires an explicit key strategy'
        });
        continue;
      }

      const text = finding.texts?.[0] ?? finding.normalizedText ?? finding.rawText;
      const suggestedKey = finding.suggestedKey;
      if (!text || !suggestedKey) {
        report.blockedFindings.push({
          findingId: finding.id,
          filePath: finding.filePath,
          reason: !text ? 'Finding has no extractable source text' : 'Finding has no deterministic suggested key'
        });
        continue;
      }

      const normalizedValue = text.trim();
      const reusableKeys = exactValueToKeys.get(text);
      if (reusableKeys && reusableKeys.length > 0) {
        const existingKey = reusableKeys[0];
        keyByFindingId[finding.id] = existingKey;
        finding.existingSimilarKey = existingKey;
        if (existingKey === suggestedKey) {
          report.existingMatches.push({ key: existingKey, value: text, filePath: finding.filePath, findingId: finding.id });
        } else {
          report.similarValues.push({
            key: suggestedKey,
            value: text,
            existingKey,
            filePath: finding.filePath,
            findingId: finding.id
          });
        }
        continue;
      }

      const normalizedMatches = normalizedValueToKeys.get(normalizedValue);
      if (normalizedMatches && normalizedMatches.length > 0) {
        report.similarValues.push({
          key: suggestedKey,
          value: text,
          existingKey: normalizedMatches[0],
          filePath: finding.filePath,
          findingId: finding.id
        });
      }

      const reservedValue = plannedCatalog[suggestedKey];
      if (reservedValue !== undefined) {
        if (reservedValue === text) {
          keyByFindingId[finding.id] = suggestedKey;
          report.existingMatches.push({
            key: suggestedKey,
            value: text,
            filePath: finding.filePath,
            findingId: finding.id
          });
        } else {
          report.keyCollisions.push({
            key: suggestedKey,
            oldValue: reservedValue,
            newValue: text,
            filePath: finding.filePath,
            findingId: finding.id
          });
        }
        continue;
      }

      plannedCatalog[suggestedKey] = text;
      exactValueToKeys.set(text, [suggestedKey]);
      normalizedValueToKeys.set(normalizedValue, [...(normalizedValueToKeys.get(normalizedValue) ?? []), suggestedKey]);
      keyByFindingId[finding.id] = suggestedKey;
      report.newEntries.push({ key: suggestedKey, value: text, filePath: finding.filePath, findingId: finding.id });
    }

    const hasCollisions = report.keyCollisions.length > 0;
    return {
      locale,
      catalogPath,
      report,
      keyByFindingId,
      outputContent: hasCollisions ? this.serializeCatalog(existingCatalog) : this.serializeCatalog(plannedCatalog),
      changed: !hasCollisions && report.newEntries.length > 0
    };
  }

  public writePlan(plan: CatalogPlan): void {
    if (plan.report.keyCollisions.length > 0) {
      throw new Error('Catalog plan contains key collisions and cannot be written');
    }
    if (plan.locale !== this.config.i18n.sourceLocale && plan.report.newEntries.length > 0) {
      throw new Error(
        `Refusing to copy source strings into non-source locale '${plan.locale}'. Extract new keys into '${this.config.i18n.sourceLocale}' first.`
      );
    }
    if (!plan.changed) return;
    writeFilesAtomically([{ filePath: plan.catalogPath, content: plan.outputContent }]);
  }

  public extractCatalog(
    findings: Finding[],
    merge = false,
    dryRun = false,
    locale = this.config.i18n.sourceLocale
  ): CollisionReport {
    const plan = this.planCatalog(findings, locale);
    if (merge && !dryRun) this.writePlan(plan);
    return plan.report;
  }
}
