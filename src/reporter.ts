import * as path from 'node:path';
import type { ScanReport, Finding, FindingKind } from './types.js';
import { TOOL_VERSION } from './version.js';
import { writeFilesAtomically } from './io.js';

function ruleId(kind: FindingKind): string {
  const byKind: Record<FindingKind, string> = {
    JSXText: 'i18n/jsx-text',
    JSXAttribute: 'i18n/jsx-attribute',
    KnownComponentProp: 'i18n/component-prop',
    KnownFunctionArgument: 'i18n/function-argument',
    StateMessage: 'i18n/state-message',
    LocalConstUsedInUserFacingContext: 'i18n/local-constant',
    LocalObjectPropertyUsedInUserFacingContext: 'i18n/local-object-property',
    ConditionalStringUsedInUserFacingContext: 'i18n/conditional-string',
    TemplateLiteralUsedInUserFacingContext: 'i18n/template-literal',
    StringConcatenationUsedInUserFacingContext: 'i18n/string-concatenation',
    TranslationFallback: 'i18n/translation-fallback',
    TranslationDefaultValue: 'i18n/translation-default-value',
    PresentationObjectString: 'i18n/presentation-object-string',
    StaticUiRegistryString: 'i18n/static-ui-registry',
    SchemaDefaultString: 'i18n/schema-default',
    InlineLocaleCatalogString: 'i18n/inline-locale-catalog',
    ValidationMessage: 'i18n/validation-message',
    NextMetadataString: 'i18n/next-metadata-string',
    ErrorString: 'i18n/error-string',
    AmbiguousString: 'i18n/ambiguous-string'
  };
  return byKind[kind];
}

function effectiveRule(finding: Finding): string {
  return finding.rule ?? ruleId(finding.kind);
}

function codeFence(content: string, language: string): string {
  const longest = Math.max(3, ...Array.from(content.matchAll(/`+/g), match => match[0].length + 1));
  const fence = '`'.repeat(longest);
  return `${fence}${language}\n${content}\n${fence}`;
}

export class Reporter {
  private readonly report: ScanReport;

  constructor(report: ScanReport) {
    this.report = report;
  }

  public toJSON(): string {
    return JSON.stringify(this.report, null, 2);
  }

  public toMarkdown(): string {
    const summary = this.report.summary;
    let markdown = '# i18n Hardcoded String Report\n\n';
    markdown += '## Summary\n\n';
    markdown += `- Files scanned: ${summary.filesScanned}\n`;
    markdown += `- Files with findings: ${summary.filesWithFindings}\n`;
    markdown += `- Total findings: ${summary.totalFindings}\n`;
    markdown += `- High confidence: ${summary.highConfidence}\n`;
    markdown += `- Medium confidence: ${summary.mediumConfidence}\n`;
    markdown += `- Low confidence: ${summary.lowConfidence}\n`;
    markdown += `- Safe auto-fix candidates: ${summary.autoFixCandidates}\n`;
    markdown += `- Needs review: ${summary.needsReview}\n\n`;

    const active = this.report.findings.filter(finding => finding.confidence !== 'ignored');
    const sections: [string, Finding[]][] = [
      ['High-confidence findings', active.filter(finding => finding.confidence === 'high')],
      ['Needs review', active.filter(finding => finding.confidence === 'medium' || finding.confidence === 'low')]
    ];

    for (const [title, findings] of sections) {
      if (findings.length === 0) continue;
      markdown += `## ${title}\n\n`;
      for (const [file, fileFindings] of Object.entries(this.groupByFile(findings))) {
        markdown += `### ${file}\n\n`;
        for (const finding of fileFindings) {
          markdown += `#### Line ${finding.line}\n\n`;
          markdown += `${codeFence(finding.rawText ?? '', 'tsx')}\n\n`;
          markdown += `- Rule: \`${effectiveRule(finding)}\`\n`;
          markdown += `- Kind: \`${finding.kind}\`\n`;
          if (finding.expressionKind) markdown += `- Expression: \`${finding.expressionKind}\`\n`;
          markdown += `- Confidence: \`${finding.confidence}\`\n`;
          markdown += `- Fixability: \`${finding.fixability}\`\n`;
          markdown += `- Reason: ${finding.reason}\n`;
          if (finding.suggestedKey) markdown += `- Suggested key: \`${finding.suggestedKey}\`\n`;
          if (finding.resolvedTranslationKey) markdown += `- Referenced translation key: \`${finding.resolvedTranslationKey}\`\n`;
          if (finding.catalogStatus) {
            markdown += `- Source catalog status: \`${finding.catalogStatus}\``;
            if (finding.catalogStatusReason) markdown += ` — ${finding.catalogStatusReason}`;
            markdown += '\n';
          }
          markdown += '\n';
        }
      }
    }

    return markdown;
  }

  public toSARIF(): string {
    const active = this.report.findings.filter(finding => finding.confidence !== 'ignored');
    const rules = [...new Set(active.map(effectiveRule))].sort().map(id => ({
      id,
      shortDescription: { text: 'Hardcoded or embedded user-facing source string' },
      fullDescription: { text: 'User-facing source copy should follow the configured i18n policy and catalog architecture.' },
      helpUri: 'https://github.com/NaoufalBtd/i18n-detection'
    }));

    const results = active.map(finding => ({
      ruleId: effectiveRule(finding),
      level: finding.confidence === 'high' ? 'error' : finding.confidence === 'medium' ? 'warning' : 'note',
      message: {
        text: `[i18n-scan] ${finding.reason}. Suggested key: ${finding.suggestedKey ?? 'n/a'}. Fixability: ${finding.fixability}.`
      },
      partialFingerprints: {
        'i18nScanFingerprint/v1': finding.fingerprint
      },
      properties: {
        confidence: finding.confidence,
        kind: finding.kind,
        semanticRule: finding.rule,
        expressionKind: finding.expressionKind,
        fixability: finding.fixability,
        suggestedKey: finding.suggestedKey,
        translationNamespace: finding.translationNamespace,
        referencedTranslationKey: finding.referencedTranslationKey,
        resolvedTranslationKey: finding.resolvedTranslationKey,
        catalogStatus: finding.catalogStatus
      },
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: finding.filePath.replace(/\\/g, '/') },
            region: {
              startLine: finding.line,
              startColumn: finding.column,
              endLine: finding.endLine,
              endColumn: finding.endColumn
            }
          }
        }
      ]
    }));

    return JSON.stringify(
      {
        $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
        version: '2.1.0',
        runs: [
          {
            tool: {
              driver: {
                name: 'i18n-scan',
                version: TOOL_VERSION,
                informationUri: 'https://github.com/NaoufalBtd/i18n-detection',
                rules
              }
            },
            results
          }
        ]
      },
      null,
      2
    );
  }

  public save(format: 'json' | 'markdown' | 'sarif', outputPath: string): void {
    const resolved = path.resolve(outputPath);
    const content = format === 'json' ? this.toJSON() : format === 'markdown' ? this.toMarkdown() : this.toSARIF();
    if (resolved === path.resolve(process.cwd(), '.i18n-scan-cache.json')) {
      throw new Error('Report output path cannot overwrite the scanner cache');
    }
    writeFilesAtomically([{ filePath: resolved, content }]);
  }

  private groupByFile(findings: Finding[]): Record<string, Finding[]> {
    const grouped: Record<string, Finding[]> = {};
    for (const finding of findings) (grouped[finding.filePath] ??= []).push(finding);
    return grouped;
  }
}
