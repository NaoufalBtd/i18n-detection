import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_CONFIG } from './config.js';
import { Extractor } from './extractor.js';
import type { Finding, ScannerConfig } from './types.js';

function finding(): Finding {
  return {
    id: 'unknown',
    fingerprint: 'fp-unknown',
    filePath: 'src/Page.tsx',
    line: 1,
    column: 1,
    endLine: 1,
    endColumn: 2,
    rawText: 'Unknown feature',
    normalizedText: 'Unknown feature',
    kind: 'JSXText',
    confidence: 'high',
    reason: 'test',
    suggestedKey: 'unknownFeature.page.title',
    autoFixCandidate: true,
    fixability: 'safe',
    fixStrategy: 'replace-jsx-text',
    needsReview: false
  };
}

describe('strict catalog routing isolation', () => {
  it('does not parse an unused fallback catalog for an unroutable key', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-strict-unused-'));
    try {
      fs.mkdirSync(path.join(root, 'messages'), { recursive: true });
      fs.writeFileSync(path.join(root, 'messages/en.json'), '{ malformed', 'utf8');
      const config: ScannerConfig = {
        ...DEFAULT_CONFIG,
        i18n: {
          ...DEFAULT_CONFIG.i18n,
          messagesPath: 'messages/{locale}.json',
          catalogRouting: 'strict',
          catalogRoutes: [
            {
              namespace: 'products',
              messagesPath: 'locales/{locale}/products.json',
              stripNamespace: true
            }
          ]
        }
      };

      const plan = new Extractor(config, root).planCatalogs([finding()])[0];
      expect(plan.report.blockedFindings).toHaveLength(1);
      expect(plan.report.blockedFindings[0].reason).toMatch(/No catalog route matches/);
      expect(plan.changed).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
