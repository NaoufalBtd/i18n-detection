import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_CONFIG } from './config.js';
import { Scanner } from './scanner.js';

describe('semantic scanner coverage', () => {
  it('detects custom translation fallbacks without treating them as violations safe to fix', () => {
    const scanner = new Scanner(DEFAULT_CONFIG);
    const report = scanner.scanInMemory('apps/web/src/storefront/ProductPurchaseIsland.tsx', `
      export function ProductPurchaseIsland() {
        const translations = { t: (_key: string, fallback: string) => fallback };
        const t = (key: string, fallback: string) => translations.t(key, fallback);
        return <button>{t('actions.buyNow', 'Buy now')}</button>;
      }
    `);
    const finding = report.findings.find(item => item.kind === 'TranslationFallback');
    expect(finding?.rawText).toBe('Buy now');
    expect(finding?.confidence).toBe('low');
    expect(finding?.autoFixCandidate).toBe(false);
  });

  it('detects next-intl defaultValue source copy', () => {
    const scanner = new Scanner(DEFAULT_CONFIG);
    const report = scanner.scanInMemory('apps/web/src/storefront/useProductListingTranslations.ts', `
      export function useProductListingTranslations(t: any) {
        return {
          searchAction: t('searchAction', { defaultValue: 'Search products' }),
          results: t('results', { count: 2, defaultValue: '{count} products' })
        };
      }
    `);
    const defaults = report.findings.filter(item => item.kind === 'TranslationDefaultValue');
    expect(defaults.map(item => item.rawText)).toEqual(['Search products', '{count} products']);
    expect(defaults.every(item => item.confidence === 'low')).toBe(true);
  });

  it('detects hardcoded copy hidden behind translation-shaped object hooks', () => {
    const scanner = new Scanner(DEFAULT_CONFIG);
    const report = scanner.scanInMemory('apps/web/src/admin/features/assets/useAssetManagementTranslations.ts', `
      export function useAssetManagementTranslations() {
        return {
          pageTitle: 'Assets',
          actions: { upload: 'Upload Assets', delete: 'Delete Asset' },
          status: { active: 'Ready' },
          technical: { tone: 'success' }
        };
      }
    `);
    const values = report.findings
      .filter(item => item.kind === 'PresentationObjectString')
      .map(item => item.rawText);
    expect(values).toEqual(expect.arrayContaining(['Assets', 'Upload Assets', 'Delete Asset', 'Ready']));
    expect(values).not.toContain('success');
  });

  it('detects presenter and adapter labels without scanning unrelated enum values', () => {
    const scanner = new Scanner(DEFAULT_CONFIG);
    const report = scanner.scanInMemory('apps/web/src/storefront/statusPresenter.ts', `
      export function getOrderStatusPresentation() {
        return {
          labelKey: 'status.paymentPending',
          defaultLabel: 'Pending Payment',
          color: 'warning',
          action: 'view-order'
        };
      }
    `);
    const values = report.findings.map(item => item.rawText);
    expect(values).toContain('Pending Payment');
    expect(values).not.toContain('warning');
    expect(values).not.toContain('view-order');
  });

  it('detects column-factory fallback copy in labels objects', () => {
    const scanner = new Scanner(DEFAULT_CONFIG);
    const report = scanner.scanInMemory('apps/web/src/admin/category-columns.tsx', `
      export function getCategoryColumns(t?: any) {
        const labels = {
          columns: {
            name: t?.columns?.name ?? 'Category',
            status: t?.columns?.status ?? 'Lifecycle',
            actions: t?.columns?.actions ?? 'Actions'
          }
        };
        return [{ header: labels.columns.name }];
      }
    `);
    const texts = report.findings.flatMap(item => item.texts ?? (item.rawText ? [item.rawText] : []));
    expect(texts).toEqual(expect.arrayContaining(['Category', 'Lifecycle', 'Actions']));
  });

  it('detects inline locale maps as migration smells', () => {
    const scanner = new Scanner(DEFAULT_CONFIG);
    const report = scanner.scanInMemory('apps/web/src/storefront/BuyerAddressForm.tsx', `
      const LABEL_COPY = {
        en: { Home: 'Home', Work: 'Work' },
        fr: { Home: 'Domicile', Work: 'Travail' },
        ar: { Home: 'المنزل', Work: 'العمل' }
      };
      export function BuyerAddressForm() { return <div />; }
    `);
    const inline = report.findings.filter(item => item.kind === 'InlineLocaleCatalogString');
    expect(inline.length).toBe(6);
    expect(inline.some(item => item.rawText === 'Travail')).toBe(true);
  });

  it('detects zod-style validation messages but ignores technical defaults', () => {
    const scanner = new Scanner(DEFAULT_CONFIG);
    const report = scanner.scanInMemory('packages/contracts/src/v1/schemas/user.ts', `
      const z: any = {};
      const schema = z.string()
        .min(1, 'First name is required')
        .max(50, 'First name too long')
        .default('en');
      const refined = z.object({}).refine(() => false, {
        message: 'Passwords do not match',
        path: ['confirmPassword']
      });
    `);
    const validation = report.findings.filter(item => item.kind === 'ValidationMessage');
    expect(validation.map(item => item.rawText)).toEqual(
      expect.arrayContaining(['First name is required', 'First name too long', 'Passwords do not match'])
    );
    expect(report.findings.some(item => item.rawText === 'en')).toBe(false);
  });

  it('detects hardcoded Next.js metadata including templated titles', () => {
    const scanner = new Scanner(DEFAULT_CONFIG);
    const report = scanner.scanInMemory('apps/web/src/app/[locale]/admin/assets/page.tsx', `
      export async function generateMetadata() {
        const brand = { platformName: 'MediaShopping' };
        return {
          title: \`Assets Library - \${brand.platformName}\`,
          description: 'Manage storefront media assets'
        };
      }
    `);
    expect(report.findings.some(item => item.userFacingContext?.type === 'NextMetadata')).toBe(true);
    expect(report.findings.some(item => item.rawText === 'Manage storefront media assets')).toBe(true);
  });

  it('detects translated templates that retain hardcoded fragments', () => {
    const scanner = new Scanner(DEFAULT_CONFIG);
    const report = scanner.scanInMemory('apps/web/src/admin/AssetDetailsDrawer.tsx', `
      export function message(t: any, count: number) {
        return \`${'${'}t('replaceMessage')} This asset has ${'${'}count} known usages.\`;
      }
    `);
    const finding = report.findings.find(item => item.userFacingContext?.type === 'TranslatedLiteralFragment');
    expect(finding?.kind).toBe('TemplateLiteralUsedInUserFacingContext');
    expect(finding?.confidence).toBe('medium');
  });

  it('discovers js/jsx plus monorepo app and package source roots by default', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-monorepo-'));
    try {
      const files = [
        path.join(root, 'src', 'legacy.jsx'),
        path.join(root, 'apps', 'web', 'src', 'page.tsx'),
        path.join(root, 'packages', 'contracts', 'src', 'schema.ts')
      ];
      for (const file of files) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, 'export const value = 1;', 'utf8');
      }
      const scanner = new Scanner(DEFAULT_CONFIG, root);
      const discovered = await scanner.getTargetFiles();
      expect(discovered.map(file => path.relative(root, file).replace(/\\/g, '/'))).toEqual([
        'apps/web/src/page.tsx',
        'packages/contracts/src/schema.ts',
        'src/legacy.jsx'
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
