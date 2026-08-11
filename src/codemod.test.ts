import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Scanner } from './scanner.js';
import { CodemodEngine } from './codemod.js';
import { DEFAULT_CONFIG } from './config.js';
import type { ScannerConfig } from './types.js';

function codemodConfig(): ScannerConfig {
  return {
    ...DEFAULT_CONFIG,
    features: { ...DEFAULT_CONFIG.features, codemod: true },
    codemod: { ...DEFAULT_CONFIG.codemod, framework: 'next-intl' }
  };
}

function withSource(code: string, callback: (root: string, filePath: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-codemod-'));
  const filePath = path.join(root, 'Page.tsx');
  fs.writeFileSync(filePath, code, 'utf8');
  try {
    callback(root, filePath);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe('codemod safety', () => {
  it('injects one next-intl translator and safely rewrites multiple findings', () => {
    withSource(`
      export function Page() {
        return <><h1>Account settings</h1><input placeholder="Search users" /></>;
      }
    `, (root, filePath) => {
      const config = codemodConfig();
      const report = new Scanner(config, root).scanFiles([filePath], false);
      const results = new CodemodEngine(config, root).planCodemods(report.findings, [filePath], {
        dryRun: true,
        confidence: 'high'
      });
      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(true);
      expect(results[0].patches).toHaveLength(2);
      expect(results[0].plannedContent).toMatch(/import \{ useTranslations \} from ["']next-intl["'];/);
      expect(results[0].plannedContent?.match(/const t = useTranslations\(\);/g)).toHaveLength(1);
    });
  });

  it('uses getTranslations for async server components', () => {
    withSource(`export async function Page(){ return <h1>Hello world</h1>; }`, (root, filePath) => {
      const config = codemodConfig();
      const report = new Scanner(config, root).scanFiles([filePath], false);
      const result = new CodemodEngine(config, root).planCodemods(report.findings, [filePath], {
        dryRun: true,
        confidence: 'high'
      })[0];
      expect(result.success).toBe(true);
      expect(result.plannedContent).toMatch(/from ["']next-intl\/server["']/);
      expect(result.plannedContent).toContain('const t = await getTranslations();');
    });
  });

  it('converts a global planned key to a deterministic namespace-relative call', () => {
    withSource(`
      import { useTranslations } from 'next-intl';
      export function Page() {
        const t = useTranslations('Page');
        return <h1>Hello world</h1>;
      }
    `, (root, filePath) => {
      const config = codemodConfig();
      const report = new Scanner(config, root).scanFiles([filePath], false);
      const finding = report.findings.find(item => item.rawText === 'Hello world')!;
      expect(finding.suggestedKey?.startsWith('Page.')).toBe(true);
      const result = new CodemodEngine(config, root).planCodemods(report.findings, [filePath], {
        dryRun: true,
        confidence: 'high'
      })[0];
      expect(result.success).toBe(true);
      expect(result.plannedContent).toContain('t("page.helloWorld")');
      expect(result.plannedContent).not.toContain('t("Page.page.helloWorld")');
    });
  });

  it('blocks namespaced codemods when the catalog key is outside the visible namespace', () => {
    withSource(`
      import { useTranslations } from 'next-intl';
      export function Page() {
        const t = useTranslations('products.listing');
        return <h1>Hello world</h1>;
      }
    `, (root, filePath) => {
      const config = codemodConfig();
      const report = new Scanner(config, root).scanFiles([filePath], false);
      const finding = report.findings.find(item => item.rawText === 'Hello world')!;
      const result = new CodemodEngine(config, root).planCodemods(report.findings, [filePath], {
        dryRun: true,
        confidence: 'high',
        keyOverrides: { [finding.id]: 'ui.common.helloWorld' }
      })[0];
      expect(result.success).toBe(false);
      expect(result.blocked[0].reason).toMatch(/outside that namespace/);
    });
  });

  it('does not mistake a nested t declaration for a visible translator', () => {
    withSource(`
      export function Page() {
        if (false) { const t = useTranslations(); }
        return <h1>Hello world</h1>;
      }
    `, (root, filePath) => {
      const config = codemodConfig();
      const report = new Scanner(config, root).scanFiles([filePath], false);
      const result = new CodemodEngine(config, root).planCodemods(report.findings, [filePath], {
        dryRun: true,
        confidence: 'high'
      })[0];
      expect(result.success).toBe(true);
      expect(result.plannedContent).toContain('const t = useTranslations();');
    });
  });

  it('blocks a syntactically valid rewrite when configured project TypeScript validation introduces diagnostics', () => {
    withSource(`export function Page(){ return <h1>Hello world</h1>; }`, (root, filePath) => {
      fs.writeFileSync(
        path.join(root, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            target: 'ES2022',
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            jsx: 'react-jsx',
            noEmit: true,
            skipLibCheck: true
          },
          include: ['Page.tsx']
        }),
        'utf8'
      );
      const base = codemodConfig();
      const config: ScannerConfig = {
        ...base,
        codemod: {
          ...base.codemod,
          framework: 'next-intl',
          tsconfigPath: 'tsconfig.json',
          requireProjectValidation: true
        }
      };
      const report = new Scanner(config, root).scanFiles([filePath], false);
      const result = new CodemodEngine(config, root).planCodemods(report.findings, [filePath], {
        dryRun: true,
        confidence: 'high'
      })[0];
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Project TypeScript validation/);
    });
  });
});
