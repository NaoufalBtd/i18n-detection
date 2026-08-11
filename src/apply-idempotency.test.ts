import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_CONFIG } from './config.js';
import { CodemodEngine, selectFixableFindings } from './codemod.js';
import { Extractor } from './extractor.js';
import { writeFilesAtomically } from './io.js';
import { Scanner } from './scanner.js';
import type { ScannerConfig } from './types.js';

function setNested(target: Record<string, unknown>, key: string, value: string): void {
  const parts = key.split('.');
  let current = target;
  for (let index = 0; index < parts.length - 1; index++) {
    const part = parts[index];
    const existing = current[part];
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) current[part] = {};
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
}

function writeCatalog(root: string, locale: string, key: string, value: string): void {
  const catalog: Record<string, unknown> = {};
  setNested(catalog, key, value);
  const filePath = path.join(root, 'messages', `${locale}.json`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(catalog), 'utf8');
}

describe('apply transaction idempotency', () => {
  it('applies a parity-safe hardcode once and leaves no second auto-fix', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-apply-idempotent-'));
    try {
      const filePath = path.join(root, 'src', 'Page.tsx');
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(
        filePath,
        `export function Page() { return <h1>Hello customers</h1>; }`,
        'utf8'
      );

      const config: ScannerConfig = {
        ...DEFAULT_CONFIG,
        include: ['src/**/*.{ts,tsx}'],
        i18n: {
          ...DEFAULT_CONFIG.i18n,
          sourceLocale: 'en',
          requiredLocales: ['en', 'fr', 'ar'],
          messagesPath: 'messages/{locale}.json'
        },
        features: {
          ...DEFAULT_CONFIG.features,
          codemod: true
        },
        codemod: {
          framework: 'next-intl'
        }
      };

      const firstReport = new Scanner(config, root).scanFiles([filePath], false);
      const selected = selectFixableFindings(firstReport.findings, { confidence: 'high' });
      expect(selected).toHaveLength(1);
      const key = selected[0].suggestedKey!;

      writeCatalog(root, 'fr', key, 'Bonjour clients');
      writeCatalog(root, 'ar', key, 'مرحبا بالعملاء');

      const extractor = new Extractor(config, root);
      const catalogPlans = extractor.planCatalogs(selected, 'en');
      expect(extractor.validateRequiredLocales(catalogPlans)).toEqual([]);

      const keyOverrides = Object.assign({}, ...catalogPlans.map(plan => plan.keyByFindingId));
      const codemodResults = new CodemodEngine(config, root).planCodemods(firstReport.findings, [filePath], {
        dryRun: true,
        confidence: 'high',
        keyOverrides
      });
      expect(codemodResults).toHaveLength(1);
      expect(codemodResults[0].success).toBe(true);
      expect(codemodResults[0].modified).toBe(true);

      writeFilesAtomically([
        {
          filePath,
          content: codemodResults[0].plannedContent!
        },
        ...catalogPlans
          .filter(plan => plan.changed)
          .map(plan => ({ filePath: plan.catalogPath, content: plan.outputContent }))
      ]);

      const secondReport = new Scanner(config, root).scanFiles([filePath], false);
      expect(secondReport.findings.some(finding => finding.rawText === 'Hello customers')).toBe(false);
      expect(selectFixableFindings(secondReport.findings, { confidence: 'high' })).toHaveLength(0);

      const secondCodemod = new CodemodEngine(config, root).planCodemods(secondReport.findings, [filePath], {
        dryRun: true,
        confidence: 'high'
      });
      expect(secondCodemod).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
