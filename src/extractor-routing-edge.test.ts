import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_CONFIG } from './config.js';
import { Extractor } from './extractor.js';
import type { Finding, ScannerConfig } from './types.js';

function finding(key: string, value: string): Finding {
  return {
    id: key,
    fingerprint: `fp:${key}`,
    filePath: 'src/Page.tsx',
    line: 1,
    column: 1,
    endLine: 1,
    endColumn: 2,
    rawText: value,
    normalizedText: value,
    kind: 'JSXText',
    confidence: 'high',
    reason: 'test',
    suggestedKey: key,
    autoFixCandidate: true,
    fixability: 'safe',
    fixStrategy: 'replace-jsx-text',
    needsReview: false
  };
}

function writeJson(root: string, relative: string, value: unknown): void {
  const filePath = path.join(root, relative);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value), 'utf8');
}

describe('catalog route precedence', () => {
  it('uses the exact longest-prefix route when validating source placeholders', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-overlap-route-'));
    try {
      const config: ScannerConfig = {
        ...DEFAULT_CONFIG,
        i18n: {
          ...DEFAULT_CONFIG.i18n,
          sourceLocale: 'en',
          requiredLocales: ['en', 'fr'],
          catalogRouting: 'strict',
          catalogRoutes: [
            {
              namespace: 'admin.homepageManagement',
              messagesPath: 'locales/{locale}/admin/homepageManagement.json',
              stripNamespace: true
            },
            {
              namespace: 'admin.homepageManagement.sectionForm',
              messagesPath: 'locales/{locale}/admin/homepageSectionForm.json',
              stripNamespace: true
            }
          ]
        }
      };
      writeJson(root, 'locales/en/admin/homepageManagement.json', {
        sectionForm: { helper: 'Wrong parent {other}' }
      });
      writeJson(root, 'locales/en/admin/homepageSectionForm.json', {
        helper: 'Choose {count} items'
      });
      writeJson(root, 'locales/fr/admin/homepageSectionForm.json', {
        helper: 'Choisir {count} éléments'
      });

      const extractor = new Extractor(config, root);
      const plans = extractor.planCatalogs([
        finding('admin.homepageManagement.sectionForm.helper', 'Choose {count} items')
      ]);
      expect(plans).toHaveLength(1);
      expect(plans[0].namespace).toBe('admin.homepageManagement.sectionForm');
      expect(extractor.validateRequiredLocales(plans)).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
