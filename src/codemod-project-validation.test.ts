import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_CONFIG } from './config.js';
import { CodemodEngine } from './codemod.js';
import { Scanner } from './scanner.js';
import type { ScannerConfig } from './types.js';

function write(root: string, relative: string, content: string): string {
  const filePath = path.join(root, relative);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

describe('project-level codemod validation', () => {
  it('does not treat a shifted pre-existing diagnostic as newly introduced', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-project-validation-'));
    try {
      const filePath = write(root, 'Page.tsx', `
        const existing: string = 123;
        export function Page() { return <h1>Hello world</h1>; }
      `);
      write(root, 'types.d.ts', `
        declare module 'next-intl' {
          export function useTranslations(namespace?: string): (key: string) => string;
        }
        declare module 'react/jsx-runtime' {
          export const jsx: any;
          export const jsxs: any;
          export const Fragment: any;
        }
        declare namespace JSX { interface IntrinsicElements { h1: any } }
      `);
      write(root, 'tsconfig.json', JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          jsx: 'react-jsx',
          noEmit: true,
          skipLibCheck: true,
          strict: true
        },
        include: ['Page.tsx', 'types.d.ts']
      }));

      const config: ScannerConfig = {
        ...DEFAULT_CONFIG,
        features: { ...DEFAULT_CONFIG.features, codemod: true },
        codemod: {
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

      expect(result.success).toBe(true);
      expect(result.modified).toBe(true);
      expect(result.plannedContent).toMatch(/from ["']next-intl["']/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
