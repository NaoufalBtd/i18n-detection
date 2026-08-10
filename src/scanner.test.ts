import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Scanner, parseSuppressions } from './scanner.js';
import { DEFAULT_CONFIG } from './config.js';
import type { ScannerConfig } from './types.js';

const testConfig: ScannerConfig = { ...DEFAULT_CONFIG, scanErrors: true };

describe('scanner', () => {
  it('detects direct JSX text and user-facing attributes', () => {
    const scanner = new Scanner(testConfig);
    const report = scanner.scanInMemory('src/components/Test.tsx', `
      export function Component() {
        return <div><h1>Account settings</h1><input placeholder="Search users" id="technical" /></div>;
      }
    `);
    const active = report.findings.filter(finding => finding.confidence !== 'ignored');
    expect(active.map(finding => finding.rawText)).toEqual(['Account settings', 'Search users']);
    expect(active.every(finding => finding.autoFixCandidate)).toBe(true);
  });

  it('does not classify traced constants as safe auto-fixes', () => {
    const scanner = new Scanner(testConfig);
    const report = scanner.scanInMemory('src/components/Test.tsx', `
      const title = "Account settings";
      export function Component() { return <h1>{title}</h1>; }
    `);
    const finding = report.findings.find(item => item.confidence !== 'ignored');
    expect(finding?.kind).toBe('LocalConstUsedInUserFacingContext');
    expect(finding?.autoFixCandidate).toBe(false);
    expect(finding?.fixability).toBe('review');
  });

  it('honors detector feature flags', () => {
    const config: ScannerConfig = {
      ...testConfig,
      features: { ...testConfig.features, sameFileConstants: false, templateLiterals: false }
    };
    const scanner = new Scanner(config);
    const report = scanner.scanInMemory('src/components/Test.tsx', `
      const title = "Account settings";
      export function Component() { return <><h1>{title}</h1><h2>{\`Welcome \${name}\`}</h2></>; }
    `);
    expect(report.summary.totalFindings).toBe(0);
  });

  it('detects text inside fragments and logical rendering expressions', () => {
    const scanner = new Scanner(testConfig);
    const report = scanner.scanInMemory('src/components/Test.tsx', `
      export function Component({ empty }) { return <>Hello{empty && "No results"}</>; }
    `);
    const active = report.findings.filter(finding => finding.confidence !== 'ignored');
    expect(active.some(finding => finding.rawText === 'Hello')).toBe(true);
    expect(active.some(finding => finding.texts?.includes('No results'))).toBe(true);
  });

  it('preserves template interpolation expressions without marking them safe', () => {
    const scanner = new Scanner(testConfig);
    const report = scanner.scanInMemory('src/components/Test.tsx', `
      export function Component({ user }) { return <h1>{\`Welcome \${user.name}\`}</h1>; }
    `);
    const finding = report.findings.find(item => item.kind === 'TemplateLiteralUsedInUserFacingContext');
    expect(finding?.confidence).toBe('medium');
    expect(finding?.autoFixCandidate).toBe(false);
    expect(Object.values(finding?.interpolationExpressions ?? {})).toContain('user.name');
  });

  it('only parses suppressions from actual comments', () => {
    const suppressions = parseSuppressions(`
      const example = "i18n-scan-ignore-file -- documentation";
      // i18n-scan-ignore-next-line -- intentionally hardcoded legal value
      const value = "Terms";
    `);
    expect(suppressions.fileIgnored).toBe(false);
    expect(suppressions.totalCount).toBe(1);
    expect(suppressions.withoutReasonCount).toBe(0);
  });

  it('invalidates cache when configuration changes', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-cache-'));
    const filePath = path.join(root, 'Page.tsx');
    fs.writeFileSync(filePath, 'export function Page(){ return <h1>Hello world</h1> }', 'utf8');
    try {
      const first = new Scanner(DEFAULT_CONFIG, root).scanFiles([filePath], true);
      expect(first.summary.totalFindings).toBe(1);
      const changedConfig: ScannerConfig = { ...DEFAULT_CONFIG, allowedStrings: [...DEFAULT_CONFIG.allowedStrings, 'Hello world'] };
      const second = new Scanner(changedConfig, root).scanFiles([filePath], true);
      expect(second.summary.totalFindings).toBe(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
