import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Scanner } from './scanner.js';
import { DEFAULT_CONFIG } from './config.js';
import type { ScannerConfig, ScanReport } from './types.js';

const fixturesDir = path.resolve(process.cwd(), 'fixtures');

function runFixture(fileName: string): ScanReport {
  const config: ScannerConfig = {
    ...DEFAULT_CONFIG,
    scanErrors: true
  };
  // Run scan relative to workspace root (the folder containing tools/i18n-scan)
  const workspaceRoot = path.resolve(process.cwd(), '../..');
  const scanner = new Scanner(config, workspaceRoot);
  const inputPath = path.join(fixturesDir, `${fileName}.input.tsx`);
  const report = scanner.scanFiles([inputPath]);

  // Strip dynamic / absolute properties from findings to make snapshots stable
  report.generatedAt = '2026-06-14T00:00:00.000Z';
  report.projectRoot = '/repo';
  report.findings.forEach(f => {
    f.filePath = f.filePath.replace(/.*fixtures\//, 'fixtures/');
    f.id = f.id.replace(/.*fixtures\//, 'fixtures/');
    if (f.declarationLocation) {
      f.declarationLocation.file = f.declarationLocation.file.replace(/.*fixtures\//, 'fixtures/');
    }
    if (f.usageLocation) {
      f.usageLocation.file = f.usageLocation.file.replace(/.*fixtures\//, 'fixtures/');
    }
  });

  return report;
}

describe('Fixture Tests', () => {
  const fixtures = ['jsx-text', 'local-constant', 'object-spread', 'template-literal'];

  fixtures.forEach(fixture => {
    it(`verifies ${fixture} fixture`, () => {
      const report = runFixture(fixture);
      const expectedPath = path.join(fixturesDir, `${fixture}.expected.json`);

      // If expected file does not exist, write it (acts as snapshot creation)
      if (!fs.existsSync(expectedPath)) {
        fs.writeFileSync(expectedPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
      }

      const expectedReportContent = fs.readFileSync(expectedPath, 'utf8');
      const expectedReport = JSON.parse(expectedReportContent);

      expect(report.summary).toEqual(expectedReport.summary);
      expect(report.findings).toHaveLength(expectedReport.findings.length);

      report.findings.forEach((finding, idx) => {
        const expected = expectedReport.findings[idx];
        expect(finding.kind).toBe(expected.kind);
        expect(finding.confidence).toBe(expected.confidence);
        expect(finding.rawText).toBe(expected.rawText);
        expect(finding.normalizedText).toBe(expected.normalizedText);
        expect(finding.suggestedKey).toBe(expected.suggestedKey);
      });
    });
  });
});
