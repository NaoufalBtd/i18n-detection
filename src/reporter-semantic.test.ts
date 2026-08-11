import { describe, expect, it } from 'vitest';
import { Reporter } from './reporter.js';
import type { ScanReport } from './types.js';

function report(): ScanReport {
  return {
    schemaVersion: '1.2',
    generatedAt: '2026-08-11T00:00:00.000Z',
    projectRoot: '/repo',
    summary: {
      filesScanned: 1,
      filesWithFindings: 1,
      totalFindings: 1,
      highConfidence: 0,
      mediumConfidence: 0,
      lowConfidence: 1,
      autoFixCandidates: 0,
      needsReview: 1
    },
    suppressions: { total: 0, withoutReason: 0 },
    findings: [
      {
        id: 'fallback',
        fingerprint: 'i18n-v1:test',
        filePath: 'apps/web/src/useTranslations.ts',
        line: 1,
        column: 1,
        endLine: 1,
        endColumn: 10,
        rawText: 'Search',
        normalizedText: 'Search',
        kind: 'TranslationDefaultValue',
        rule: 'i18n/translation-default-value',
        expressionKind: 'literal',
        confidence: 'low',
        reason: 'Translation default source copy',
        userFacingContext: { type: 'TranslationDefaultValue' },
        suggestedKey: 'products.listing.searchAction',
        autoFixCandidate: false,
        fixability: 'review',
        needsReview: true,
        translationNamespace: 'products.listing',
        referencedTranslationKey: 'searchAction',
        resolvedTranslationKey: 'products.listing.searchAction',
        fallbackValue: 'Search',
        catalogStatus: 'present',
        catalogStatusReason: 'Fallback matches the source catalog'
      }
    ]
  };
}

describe('semantic reporter metadata', () => {
  it('shows semantic rule, expression shape, and catalog provenance in Markdown', () => {
    const markdown = new Reporter(report()).toMarkdown();
    expect(markdown).toContain('i18n/translation-default-value');
    expect(markdown).toContain('Expression: `literal`');
    expect(markdown).toContain('products.listing.searchAction');
    expect(markdown).toContain('Source catalog status: `present`');
  });

  it('includes semantic provenance in SARIF properties', () => {
    const sarif = JSON.parse(new Reporter(report()).toSARIF()) as {
      runs: { results: { ruleId: string; properties: Record<string, unknown> }[] }[];
    };
    const result = sarif.runs[0].results[0];
    expect(result.ruleId).toBe('i18n/translation-default-value');
    expect(result.properties.expressionKind).toBe('literal');
    expect(result.properties.resolvedTranslationKey).toBe('products.listing.searchAction');
    expect(result.properties.catalogStatus).toBe('present');
  });
});
