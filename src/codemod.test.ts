import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Scanner } from './scanner.js';
import { CodemodEngine } from './codemod.js';
import { DEFAULT_CONFIG } from './config.js';

describe('Codemod Engine Tests', () => {
  it('applies JSXText and JSXAttribute codemods safely', () => {
    const config = {
      ...DEFAULT_CONFIG,
      i18n: {
        ...DEFAULT_CONFIG.i18n,
        translationFunctionName: 't'
      }
    };

    const tempDir = path.resolve(process.cwd(), 'temp-test');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const testFile = path.join(tempDir, 'Page.tsx');
    const originalCode = `
      import { useTranslations } from 'next-intl';

      export function Page() {
        const t = useTranslations('Page');
        return (
          <div>
            <h1>Account settings</h1>
            <input placeholder="Search users" />
          </div>
        );
      }
    `;

    fs.writeFileSync(testFile, originalCode, 'utf8');

    try {
      const scanner = new Scanner(config, tempDir);
      const report = scanner.scanFiles([testFile]);

      const active = report.findings.filter(f => f.confidence !== 'ignored');
      expect(active).toHaveLength(2); // Account settings, Search users

      const codemod = new CodemodEngine(config, tempDir);
      // Run in non-dry-run mode to write changes
      const results = codemod.applyCodemods(report.findings, [testFile], {
        dryRun: false,
        confidence: 'high'
      });

      expect(results).toHaveLength(1);
      expect(results[0].modified).toBe(true);
      expect(results[0].patches).toHaveLength(2);

      const updatedCode = fs.readFileSync(testFile, 'utf8');
      expect(updatedCode).toContain('<h1>{t("page.page.accountSettings")}</h1>');
      expect(updatedCode).toContain('<input placeholder={t("page.page.placeholder")} />');
    } finally {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }
  });

  it('injects import and hook if translation function t is not available in scope', () => {
    const config = {
      ...DEFAULT_CONFIG,
      codemod: {
        importStatement: "import { useTranslation } from 'react-i18next';",
        hookStatement: "const { t } = useTranslation();"
      }
    };
    const tempDir = path.resolve(process.cwd(), 'temp-test-skip');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const testFile = path.join(tempDir, 'Page.tsx');
    const codeWithoutT = `
      export function Page() {
        return (
          <div>
            <h1>Account settings</h1>
          </div>
        );
      }
    `;

    fs.writeFileSync(testFile, codeWithoutT, 'utf8');

    try {
      const scanner = new Scanner(config, tempDir);
      const report = scanner.scanFiles([testFile]);

      expect(report.findings).toHaveLength(1);

      const codemod = new CodemodEngine(config, tempDir);
      const results = codemod.applyCodemods(report.findings, [testFile], {
        dryRun: false,
        confidence: 'high'
      });

      expect(results.filter(r => r.modified)).toHaveLength(1);

      const updatedCode = fs.readFileSync(testFile, 'utf8');
      expect(updatedCode).toContain("import { useTranslation } from 'react-i18next';");
      expect(updatedCode).toContain("const { t } = useTranslation();");
      expect(updatedCode).toContain('<h1>{t("page.page.accountSettings")}</h1>');
    } finally {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }
  });

  it('saves and reads findings from cache', () => {
    const config = DEFAULT_CONFIG;
    const tempDir = path.resolve(process.cwd(), 'temp-test-cache');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const testFile = path.join(tempDir, 'Page.tsx');
    const originalCode = `
      export function Page() {
        return <h1>Hello world</h1>;
      }
    `;

    fs.writeFileSync(testFile, originalCode, 'utf8');

    try {
      const scanner = new Scanner(config, tempDir);
      
      // 1. First scan (Cache Miss, parses file and writes cache)
      const report1 = scanner.scanFiles([testFile], true);
      expect(report1.summary.totalFindings).toBe(1);

      const cacheFilePath = path.join(tempDir, '.i18n-scan-cache.json');
      expect(fs.existsSync(cacheFilePath)).toBe(true);

      // Read cache file and mutate it slightly to prove next scan reads from cache
      const cacheContent = JSON.parse(fs.readFileSync(cacheFilePath, 'utf8'));
      const relativePath = path.relative(tempDir, testFile).replace(/\\/g, '/');
      expect(cacheContent.files[relativePath]).toBeDefined();
      
      // Change finding rawText in cache
      cacheContent.files[relativePath].findings[0].rawText = 'MUTATED_CACHED_VAL';
      fs.writeFileSync(cacheFilePath, JSON.stringify(cacheContent, null, 2), 'utf8');

      // 2. Second scan (Cache Hit, loads findings from mutated cache instead of parsing AST!)
      const report2 = scanner.scanFiles([testFile], true);
      expect(report2.summary.totalFindings).toBe(1);
      expect(report2.findings[0].rawText).toBe('MUTATED_CACHED_VAL'); // Proves cache hit!
    } finally {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }
  });
});
