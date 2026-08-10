import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ScanReport, Finding } from './types.js';

export class Reporter {
  private report: ScanReport;

  constructor(report: ScanReport) {
    this.report = report;
  }

  public toJSON(): string {
    return JSON.stringify(this.report, null, 2);
  }

  public toMarkdown(): string {
    const s = this.report.summary;
    let md = `# i18n Hardcoded String Report\n\n`;

    md += `## Summary\n\n`;
    md += `- Files scanned: ${s.filesScanned}\n`;
    md += `- Files with findings: ${s.filesWithFindings}\n`;
    md += `- Total findings: ${s.totalFindings}\n`;
    md += `- High confidence: ${s.highConfidence}\n`;
    md += `- Medium confidence: ${s.mediumConfidence}\n`;
    md += `- Low confidence: ${s.lowConfidence}\n`;
    md += `- Auto-fix candidates: ${s.autoFixCandidates}\n`;
    md += `- Needs review: ${s.needsReview}\n\n`;

    const activeFindings = this.report.findings.filter(f => f.confidence !== 'ignored');

    // 1. High-confidence findings
    const high = activeFindings.filter(f => f.confidence === 'high');
    if (high.length > 0) {
      md += `## High-confidence findings\n\n`;
      const grouped = this.groupByFile(high);
      for (const [file, fileFindings] of Object.entries(grouped)) {
        md += `### ${file}\n\n`;
        for (const f of fileFindings) {
          md += `#### Line ${f.line}\n\n`;
          md += `Source:\n\n`;
          md += `\`\`\`tsx\n${f.rawText || ''}\n\`\`\`\n\n`;
          md += `Suggested key:\n\n`;
          md += `\`\`\`txt\n${f.suggestedKey || ''}\n\`\`\`\n\n`;
          md += `Suggested replacement:\n\n`;
          md += `\`\`\`tsx\n${f.suggestedReplacement || ''}\n\`\`\`\n\n`;
        }
      }
    }

    // 2. Needs review (medium & low)
    const review = activeFindings.filter(f => f.confidence === 'medium' || f.confidence === 'low');
    if (review.length > 0) {
      md += `## Needs review\n\n`;
      const grouped = this.groupByFile(review);
      for (const [file, fileFindings] of Object.entries(grouped)) {
        md += `### ${file}\n\n`;
        for (const f of fileFindings) {
          md += `#### Line ${f.line}\n\n`;
          md += `Source:\n\n`;
          md += `\`\`\`tsx\n${f.rawText || ''}\n\`\`\`\n\n`;
          md += `Reason:\n\n`;
          md += `${f.reason}\n\n`;
          md += `Suggested review direction:\n\n`;
          if (f.kind === 'TemplateLiteralUsedInUserFacingContext') {
            md += `\`\`\`tsx\nt("${f.suggestedKey || 'key'}", { /* variables */ })\n\`\`\`\n\n`;
          } else {
            md += `\`\`\`tsx\n${f.suggestedReplacement || ''}\n\`\`\`\n\n`;
          }
        }
      }
    }

    return md;
  }

  public toSARIF(): string {
    const activeFindings = this.report.findings.filter(f => f.confidence !== 'ignored');
    const results = activeFindings.map(f => {
      const level = f.confidence === 'high' ? 'error' : f.confidence === 'medium' ? 'warning' : 'note';
      return {
        ruleId: 'i18n-hardcoded-string',
        level,
        message: {
          text: `[i18n-scan] Hardcoded user-facing string detected: "${f.rawText || f.normalizedText}". Reason: ${f.reason}. Suggested Key: ${f.suggestedKey}`
        },
        locations: [
          {
            physicalLocation: {
              artifactLocation: {
                uri: f.filePath
              },
              region: {
                startLine: f.line,
                startColumn: f.column,
                endLine: f.endLine,
                endColumn: f.endColumn
              }
            }
          }
        ]
      };
    });

    const sarif = {
      $schema: 'https://schemastore.azurewebsites.net/schemas/json/sarif-2.1.0-rtm.5.json',
      version: '2.1.0',
      runs: [
        {
          tool: {
            driver: {
              name: 'i18n-scan',
              version: '1.0.0',
              informationUri: 'https://company.com/i18n-scan',
              rules: [
                {
                  id: 'i18n-hardcoded-string',
                  shortDescription: {
                    text: 'Hardcoded user-facing string'
                  },
                  fullDescription: {
                    text: 'User-facing strings should be localized using the configured i18n framework.'
                  }
                }
              ]
            }
          },
          results
        }
      ]
    };

    return JSON.stringify(sarif, null, 2);
  }

  public save(format: 'json' | 'markdown' | 'sarif', outputPath: string): void {
    const content =
      format === 'json' ? this.toJSON() : format === 'markdown' ? this.toMarkdown() : this.toSARIF();
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, content, 'utf8');
  }

  private groupByFile(findings: Finding[]): Record<string, Finding[]> {
    const grouped: Record<string, Finding[]> = {};
    for (const f of findings) {
      if (!grouped[f.filePath]) {
        grouped[f.filePath] = [];
      }
      grouped[f.filePath].push(f);
    }
    return grouped;
  }
}
