import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_CONFIG } from './config.js';
import { Extractor } from './extractor.js';
import { Scanner } from './scanner.js';
import type { Finding, ScannerConfig } from './types.js';

function mediaShoppingConfig(root: string): ScannerConfig {
  void root;
  return {
    ...DEFAULT_CONFIG,
    i18n: {
      ...DEFAULT_CONFIG.i18n,
      sourceLocale: 'en',
      requiredLocales: ['en', 'fr', 'ar'],
      messagesPath: 'apps/web/src/locales/{locale}/legacy.json',
      catalogRouting: 'strict',
      catalogRoutes: [
        { namespace: 'products', messagesPath: 'apps/web/src/locales/{locale}/storefront/products.json', stripNamespace: true },
        { namespace: 'homepage', messagesPath: 'apps/web/src/locales/{locale}/storefront/homepage.json', stripNamespace: true },
        { namespace: 'ecommerce', messagesPath: 'apps/web/src/locales/{locale}/storefront/ecommerce.json', stripNamespace: true },
        { namespace: 'content', messagesPath: 'apps/web/src/locales/{locale}/storefront/content.json', stripNamespace: true },
        { namespace: 'ui', messagesPath: 'apps/web/src/locales/{locale}/storefront/ui.json', stripNamespace: true },
        { namespace: 'user', messagesPath: 'apps/web/src/locales/{locale}/storefront/user.json', stripNamespace: true },
        { namespace: 'components', messagesPath: 'apps/web/src/locales/{locale}/storefront/components.json', stripNamespace: true },
        { namespace: 'account', messagesPath: 'apps/web/src/locales/{locale}/storefront/account.json', stripNamespace: true },
        { namespace: 'returnCase', messagesPath: 'apps/web/src/locales/{locale}/storefront/returnCase.json', stripNamespace: true },
        { namespace: 'supportTickets', messagesPath: 'apps/web/src/locales/{locale}/storefront/supportTickets.json', stripNamespace: true },
        { namespace: 'admin.categoryManagement', messagesPath: 'apps/web/src/locales/{locale}/admin/categoryManagement.json', stripNamespace: true },
        { namespace: 'admin.homepageManagement', messagesPath: 'apps/web/src/locales/{locale}/admin/homepageManagement.json', stripNamespace: true },
        { namespace: 'admin.productManagement', messagesPath: 'apps/web/src/locales/{locale}/admin/productManagement.json', stripNamespace: true },
        { namespace: 'admin.orderManagement', messagesPath: 'apps/web/src/locales/{locale}/admin/orderManagement.json', stripNamespace: true }
      ]
    },
    semantic: {
      ...DEFAULT_CONFIG.semantic!,
      translationHooks: {
        useProductTranslations: 'products',
        useCommonTranslations: 'ui.common',
        useAuthTranslations: 'user.auth'
      }
    }
  };
}

function finding(id: string, key: string, text: string): Finding {
  return {
    id,
    fingerprint: `fp-${id}`,
    filePath: 'apps/web/src/Page.tsx',
    line: 1,
    column: 1,
    endLine: 1,
    endColumn: 2,
    rawText: text,
    normalizedText: text,
    kind: 'JSXText',
    confidence: 'high',
    reason: 'acceptance fixture',
    suggestedKey: key,
    suggestedReplacement: `{t("${key}")}`,
    autoFixCandidate: true,
    fixability: 'safe',
    fixStrategy: 'replace-jsx-text',
    needsReview: false
  };
}

function writeJson(root: string, relative: string, data: unknown): void {
  const filePath = path.join(root, relative);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data), 'utf8');
}

describe('MediaShopping acceptance profile', () => {
  it('routes storefront, admin, and shared homepage-management runtime namespaces correctly', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-media-routing-'));
    try {
      const config = mediaShoppingConfig(root);
      const extractor = new Extractor(config, root);
      const plans = extractor.planCatalogs([
        finding('product', 'products.listing.emptyTitle', 'No products found'),
        finding('component', 'components.orderStatus.pending', 'Pending payment'),
        finding('category', 'admin.categoryManagement.form.helper', 'Choose a category'),
        finding('homepage-main', 'admin.homepageManagement.main.actions.save', 'Save homepage'),
        finding('homepage-section', 'admin.homepageManagement.sectionForm.actions.cancel', 'Cancel section')
      ]);

      expect(plans).toHaveLength(4);
      const homepagePlans = plans.filter(plan => plan.namespace === 'admin.homepageManagement');
      expect(homepagePlans).toHaveLength(1);
      expect(homepagePlans[0].catalogPath.endsWith('admin/homepageManagement.json')).toBe(true);
      expect(JSON.parse(homepagePlans[0].outputContent)).toEqual({
        main: { actions: { save: 'Save homepage' } },
        sectionForm: { actions: { cancel: 'Cancel section' } }
      });
      expect(plans.some(plan => plan.catalogPath.endsWith('storefront/products.json'))).toBe(true);
      expect(plans.some(plan => plan.catalogPath.endsWith('storefront/components.json'))).toBe(true);
      expect(plans.some(plan => plan.catalogPath.endsWith('admin/categoryManagement.json'))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('classifies next-intl defaultValue fallbacks as present, stale, or missing against the source catalog', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-media-fallback-'));
    try {
      const config = mediaShoppingConfig(root);
      writeJson(root, 'apps/web/src/locales/en/storefront/products.json', {
        listing: {
          searchAction: 'Search',
          clearSearch: 'Clear search'
        }
      });

      const scanner = new Scanner(config, root);
      const report = scanner.scanInMemory('apps/web/src/storefront/features/product-listing/useProductListingTranslations.ts', `
        declare function useTranslations(namespace: string): (key: string, options?: unknown) => string;
        export function useProductListingTranslations() {
          const t = useTranslations('products.listing');
          return {
            searchAction: t('searchAction', { defaultValue: 'Search' }),
            clearSearch: t('clearSearch', { defaultValue: 'Clear products' }),
            retry: t('retry', { defaultValue: 'Try again' })
          };
        }
      `);
      new Extractor(config, root).enrichTranslationFindings(report.findings);
      const byKey = new Map(
        report.findings
          .filter(item => item.kind === 'TranslationDefaultValue')
          .map(item => [item.resolvedTranslationKey, item])
      );
      expect(byKey.get('products.listing.searchAction')?.catalogStatus).toBe('present');
      expect(byKey.get('products.listing.clearSearch')?.catalogStatus).toBe('source-mismatch');
      expect(byKey.get('products.listing.retry')?.catalogStatus).toBe('missing');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('treats unknown runtime namespaces as unroutable instead of falling into a legacy catalog', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-media-strict-'));
    try {
      const extractor = new Extractor(mediaShoppingConfig(root), root);
      const plan = extractor.planCatalogs([
        finding('unknown', 'futureFeature.actions.open', 'Open feature')
      ])[0];
      expect(plan.report.blockedFindings).toHaveLength(1);
      expect(plan.report.blockedFindings[0].reason).toContain('catalogRouting is strict');
      expect(plan.catalogPath.endsWith('legacy.json')).toBe(true);
      expect(plan.changed).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
