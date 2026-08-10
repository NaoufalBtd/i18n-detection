import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Extractor } from './extractor.js';
import { DEFAULT_CONFIG } from './config.js';
import type { Finding, ScannerConfig } from './types.js';

function finding(id: string, key: string, text: string, line: number): Finding {
  return {
    id,
    fingerprint: `fp-${id}`,
    filePath: 'src/Page.tsx',
    line,
    column: 1,
    endLine: line,
    endColumn: 2,
    rawText: text,
    normalizedText: text,
    kind: 'JSXText',
    confidence: 'high',
    reason: 'test',
    suggestedKey: key,
    suggestedReplacement: `{t("${key}")}`,
    existingSimilarKey: null,
    autoFixCandidate: true,
    fixability: 'safe',
    fixStrategy: 'replace-jsx-text',
    needsReview: false
  };
}

function tempConfig(root: string): ScannerConfig {
  return {
    ...DEFAULT_CONFIG,
    i18n: {
      ...DEFAULT_CONFIG.i18n,
      messagesPath: 'messages/{locale}.json'
    }
  };
}

describe('catalog planning', () => {
  it('detects collisions between new findings in the same batch', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-extractor-'));
    try {
      const extractor = new Extractor(tempConfig(root), root);
      const plan = extractor.planCatalog([
        finding('one', 'page.dialog.title', 'Delete order', 1),
        finding('two', 'page.dialog.title', 'Cancel order', 2)
      ]);
      expect(plan.report.keyCollisions).toHaveLength(1);
      expect(plan.changed).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reuses an existing key for an identical value', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-extractor-'));
    try {
      fs.mkdirSync(path.join(root, 'messages'));
      fs.writeFileSync(path.join(root, 'messages/en.json'), JSON.stringify({ common: { save: 'Save' } }), 'utf8');
      const extractor = new Extractor(tempConfig(root), root);
      const plan = extractor.planCatalog([finding('one', 'page.button.label', 'Save', 1)]);
      expect(plan.keyByFindingId.one).toBe('common.save');
      expect(plan.report.similarValues).toHaveLength(1);
      expect(plan.report.newEntries).toHaveLength(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses to write source strings into a non-source locale', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-extractor-'));
    try {
      const extractor = new Extractor(tempConfig(root), root);
      const plan = extractor.planCatalog([finding('one', 'page.title', 'Hello', 1)], 'fr');
      expect(() => extractor.writePlan(plan)).toThrow(/non-source locale/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('blocks conditional findings rather than dropping branches', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-extractor-'));
    try {
      const conditional = finding('one', 'page.title', 'Edit', 1);
      conditional.kind = 'ConditionalStringUsedInUserFacingContext';
      conditional.confidence = 'medium';
      conditional.autoFixCandidate = false;
      conditional.fixability = 'review';
      conditional.texts = ['Edit', 'Create'];
      const plan = new Extractor(tempConfig(root), root).planCatalog([conditional]);
      expect(plan.report.blockedFindings).toHaveLength(1);
      expect(plan.report.newEntries).toHaveLength(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
