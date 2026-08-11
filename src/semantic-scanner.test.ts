import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_CONFIG } from './config.js';
import { Scanner } from './scanner.js';
import type { ScannerConfig } from './types.js';

function configWithTranslationHooks(): ScannerConfig {
  return {
    ...DEFAULT_CONFIG,
    semantic: {
      ...DEFAULT_CONFIG.semantic!,
      translationHooks: {
        useProductTranslations: 'products',
        useCommonTranslations: 'ui.common'
      }
    }
  };
}

describe('semantic scanner coverage', () => {
  it('detects custom translation fallbacks without treating them as violations safe to fix', () => {
    const scanner = new Scanner(DEFAULT_CONFIG);
    const report = scanner.scanInMemory('apps/web/src/storefront/ProductPurchaseIsland.tsx', `
      export function ProductPurchaseIsland() {
        const translations = { t: (_key: string, fallback: string) => fallback };
        return <button>{translations.t('actions.buyNow', 'Buy now')}</button>;
      }
    `);
    const finding = report.findings.find(item => item.kind === 'TranslationFallback');
    expect(finding?.rawText).toBe('Buy now');
    expect(finding?.referencedTranslationKey).toBe('actions.buyNow');
    expect(finding?.fallbackValue).toBe('Buy now');
    expect(finding?.confidence).toBe('low');
    expect(finding?.autoFixCandidate).toBe(false);
  });

  it('resolves next-intl defaultValue findings to the full runtime translation key', () => {
    const scanner = new Scanner(DEFAULT_CONFIG);
    const report = scanner.scanInMemory('apps/web/src/storefront/useProductListingTranslations.ts', `
      declare function useTranslations(namespace: string): (key: string, options?: unknown) => string;
      export function useProductListingTranslations() {
        const t = useTranslations('products.listing');
        return {
          searchAction: t('searchAction', { defaultValue: 'Search products' }),
          results: t('results', { count: 2, defaultValue: '{count} products' })
        };
      }
    `);
    const defaults = report.findings.filter(item => item.kind === 'TranslationDefaultValue');
    expect(defaults.map(item => item.rawText)).toEqual(['Search products', '{count} products']);
    expect(defaults.map(item => item.resolvedTranslationKey)).toEqual([
      'products.listing.searchAction',
      'products.listing.results'
    ]);
    expect(defaults.every(item => item.translationNamespace === 'products.listing')).toBe(true);
    expect(defaults.every(item => item.confidence === 'low')).toBe(true);
  });

  it('uses configured specialized translation hooks for namespace inference', () => {
    const scanner = new Scanner(configWithTranslationHooks());
    const report = scanner.scanInMemory('apps/web/src/storefront/ProductActions.tsx', `
      declare function useProductTranslations(): { addToCart: string };
      export function ProductActions() {
        const { addToCart } = useProductTranslations();
        return <button title="Buy this product">{addToCart}</button>;
      }
    `);
    const finding = report.findings.find(item => item.rawText === 'Buy this product');
    expect(finding?.suggestedKey?.startsWith('products.')).toBe(true);
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

  it('detects MediaShopping-style as const UI registries', () => {
    const scanner = new Scanner(DEFAULT_CONFIG);
    const report = scanner.scanInMemory('packages/contracts/src/v1/schemas/category-form.ts', `
      export const CATEGORY_TYPE_OPTIONS = [
        { value: 'STANDARD', label: 'Standard', description: 'Core browse taxonomy for shoppers' },
        { value: 'CAMPAIGN', label: 'Campaign', description: 'Time-bound marketing collections' }
      ] as const;
      export const PUBLISHING_UI_STATES = {
        DRAFT: { label: 'Draft', description: 'Draft categories are safe to edit.', chipColor: 'default' },
        ACTIVE: { label: 'Published', description: 'Published categories appear to customers.', chipColor: 'success' }
      } as const;
    `);
    const registry = report.findings.filter(item => item.kind === 'StaticUiRegistryString');
    expect(registry.map(item => item.rawText)).toEqual(expect.arrayContaining([
      'Standard',
      'Core browse taxonomy for shoppers',
      'Campaign',
      'Draft',
      'Draft categories are safe to edit.',
      'Published'
    ]));
    expect(registry.some(item => item.rawText === 'default')).toBe(false);
    expect(registry.every(item => item.rule === 'i18n/static-ui-registry')).toBe(true);
  });

  it('unwraps as const satisfies registries recursively', () => {
    const scanner = new Scanner(DEFAULT_CONFIG);
    const report = scanner.scanInMemory('packages/contracts/src/v1/data/banner-family-definitions.ts', `
      interface Definition { label: string; description: string; variants: readonly { label: string; description: string }[] }
      export const BANNER_FAMILY_DEFINITIONS = [
        {
          label: 'Hero',
          description: 'Static hero banner templates.',
          variants: [{ label: 'Variant A', description: 'Text left with media background.' }]
        }
      ] as const satisfies readonly Definition[];
    `);
    const values = report.findings
      .filter(item => item.kind === 'StaticUiRegistryString')
      .map(item => item.rawText);
    expect(values).toEqual(expect.arrayContaining([
      'Hero',
      'Static hero banner templates.',
      'Variant A',
      'Text left with media background.'
    ]));
  });

  it('detects inline locale maps as migration smells', () => {
    const scanner = new Scanner(DEFAULT_CONFIG);
    const report = scanner.scanInMemory('apps/web/src/storefront/BuyerAddressForm.tsx', `
      const LABEL_COPY = {
        en: { Home: 'Home', Work: 'Work' },
        fr: { Home: 'Domicile', Work: 'Travail' },
        ar: { Home: 'المنزل', Work: 'العمل' }
      } as const;
      export function BuyerAddressForm() { return <div />; }
    `);
    const inline = report.findings.filter(item => item.kind === 'InlineLocaleCatalogString');
    expect(inline.length).toBe(6);
    expect(inline.some(item => item.rawText === 'Travail')).toBe(true);
  });

  it('detects Zod validation messages and user-facing defaults while ignoring technical defaults', () => {
    const scanner = new Scanner(DEFAULT_CONFIG);
    const report = scanner.scanInMemory('packages/contracts/src/v1/schemas/section-registry.ts', `
      import { z } from 'zod';
      export const SectionSchema = z.object({
        title: z.string().min(1, 'Title is required').default('Shop curated collections'),
        layout: z.enum(['grid', 'list']).default('grid'),
        status: z.enum(['active', 'inactive']).default('active'),
        items: z.array(z.object({ label: z.string(), description: z.string() })).default([
          { label: 'Fast delivery', description: 'Reliable shipping with clear delivery windows.' },
          { label: 'Easy returns', description: 'Simple return support for confident shopping.' }
        ])
      });
      export const PasswordSchema = z.object({ password: z.string() }).refine(() => false, {
        message: 'Passwords do not match'
      });
    `);
    const validation = report.findings.filter(item => item.kind === 'ValidationMessage');
    expect(validation.map(item => item.rawText)).toEqual(
      expect.arrayContaining(['Title is required', 'Passwords do not match'])
    );
    const defaults = report.findings.filter(item => item.kind === 'SchemaDefaultString');
    expect(defaults.map(item => item.rawText)).toEqual(expect.arrayContaining([
      'Shop curated collections',
      'Fast delivery',
      'Reliable shipping with clear delivery windows.',
      'Easy returns',
      'Simple return support for confident shopping.'
    ]));
    expect(report.findings.some(item => item.rawText === 'grid')).toBe(false);
    expect(report.findings.some(item => item.rawText === 'active')).toBe(false);
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
    expect(finding?.expressionKind).toBe('template');
    expect(finding?.confidence).toBe('medium');
  });

  it('generates distinct semantic keys for repeated generic prop roles', () => {
    const scanner = new Scanner(DEFAULT_CONFIG);
    const report = scanner.scanInMemory('apps/web/src/ProfileForm.tsx', `
      export function ProfileForm() {
        return <><input placeholder="First name" /><input placeholder="Last name" /></>;
      }
    `);
    const placeholders = report.findings.filter(item => item.userFacingContext?.propName === 'placeholder');
    expect(placeholders).toHaveLength(2);
    expect(new Set(placeholders.map(item => item.suggestedKey)).size).toBe(2);
    expect(placeholders[0].suggestedKey).not.toBe(placeholders[1].suggestedKey);
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
