import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Scanner } from './scanner.js';
import { DEFAULT_CONFIG } from './config.js';
import type { ScannerConfig, ScanReport } from './types.js';

const fixturesDir = path.resolve(process.cwd(), 'fixtures');

function runFixture(fileName: string): ScanReport {
  const config: ScannerConfig = { ...DEFAULT_CONFIG, scanErrors: true };
  const scanner = new Scanner(config, process.cwd());
  const inputPath = path.join(fixturesDir, `${fileName}.input.tsx`);
  const report = scanner.scanFiles([inputPath], false);
  report.generatedAt = '2026-06-14T00:00:00.000Z';
  report.projectRoot = '/repo';
  return report;
}

describe('fixture regressions', () => {
  const fixtures = ['jsx-text', 'local-constant', 'object-spread', 'template-literal'];
  for (const fixture of fixtures) {
    it(`verifies ${fixture}`, () => {
      const expectedPath = path.join(fixturesDir, `${fixture}.expected.json`);
      expect(fs.existsSync(expectedPath), `Missing golden fixture ${expectedPath}`).toBe(true);
      const report = runFixture(fixture);
      const expected = JSON.parse(fs.readFileSync(expectedPath, 'utf8')) as ScanReport;
      expect(report.summary.totalFindings).toBe(expected.summary.totalFindings);
      expect(report.findings).toHaveLength(expected.findings.length);
      for (const finding of report.findings) {
        const expectedFinding = expected.findings.find(item => item.kind === finding.kind && item.rawText === finding.rawText);
        expect(expectedFinding, `Missing expected finding for ${finding.kind}: ${finding.rawText}`).toBeDefined();
        expect(finding.confidence).toBe(expectedFinding?.confidence);
        expect(finding.suggestedKey).toBe(expectedFinding?.suggestedKey);
      }
    });
  }
});
