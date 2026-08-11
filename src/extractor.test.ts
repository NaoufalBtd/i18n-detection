import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Extractor } from './extractor.js';
import { DEFAULT_CONFIG } from './config.js';
import type { Finding, ScannerConfig } from './types.js';

function finding(id: string, key: string, text: string, line: number): Finding {
  return {
    id,
    fingerprint: `fp-${id}`,
    filePath: 'src/Page.tsx',
    line,
    column: 1,
    endLine: line,
    endColumn: 2,
    rawText: text,
    normalizedText: text,
    kind: 'JSXText',
    confidence: 'high',
    reason: 'test',
    suggestedKey: key,
    suggestedReplacement: `{t("${key}")}`,
    existingSimilarKey: null,
    autoFixCandidate: true,
    fixability: 'safe',
    fixStrategy: 'replace-jsx-text',
    needsReview: false
  };
}

function tempConfig(_root: string): ScannerConfig {
  return {
    ...DEFAULT_CONFIG,
    i18n: {
      ...DEFAULT_CONFIG.i18n,
      messagesPath: 'messages/{locale}.json'
    }
  };
}

function routedConfig(): ScannerConfig {
  return {
    ...DEFAULT_CONFIG,
    i18n: {
      ...DEFAULT_CONFIG.i18n,
      messagesPath: 'messages/{locale}.json',
      catalogRoutes: [
        {
          namespace: 'products',
          messagesPath: 'apps/web/src/locales/{locale}/storefront/products.json',
          stripNamespace: true
        },
        {
          namespace: 'admin.categoryManagement',
          messagesPath: 'apps/web/src/locales/{locale}/admin/categoryManagement.json',
          stripNamespace: true
        }
      ]
    }
  };
}

describe('catalog planning', () => {
  it('detects collisions between new findings in the same batch', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-extractor-'));
    try {
      const extractor = new Extractor(tempConfig(root), root);
      const plan = extractor.planCatalog([
        finding('one', 'page.dialog.title', 'Delete order', 1),
        finding('two', 'page.dialog.title', 'Cancel order', 2)
      ]);
      expect(plan.report.keyCollisions).toHaveLength(1);
      expect(plan.changed).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reuses an existing key for an identical value', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-extractor-'));
    try {
      fs.mkdirSync(path.join(root, 'messages'));
      fs.writeFileSync(path.join(root, 'messages/en.json'), JSON.stringify({ common: { save: 'Save' } }), 'utf8');
      const extractor = new Extractor(tempConfig(root), root);
      const plan = extractor.planCatalog([finding('one', 'page.button.label', 'Save', 1)]);
      expect(plan.keyByFindingId.one).toBe('common.save');
      expect(plan.report.similarValues).toHaveLength(1);
      expect(plan.report.newEntries).toHaveLength(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses to write source strings into a non-source locale', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-extractor-'));
    try {
      const extractor = new Extractor(tempConfig(root), root);
      const plan = extractor.planCatalog([finding('one', 'page.title', 'Hello', 1)], 'fr');
      expect(() => extractor.writePlan(plan)).toThrow(/non-source locale/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('blocks conditional findings rather than dropping branches', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-extractor-'));
    try {
      const conditional = finding('one', 'page.title', 'Edit', 1);
      conditional.kind = 'ConditionalStringUsedInUserFacingContext';
      conditional.confidence = 'medium';
      conditional.autoFixCandidate = false;
      conditional.fixability = 'review';
      conditional.texts = ['Edit', 'Create'];
      const plan = new Extractor(tempConfig(root), root).planCatalog([conditional]);
      expect(plan.report.blockedFindings).toHaveLength(1);
      expect(plan.report.newEntries).toHaveLength(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('routes logical namespaces to split physical catalogs and strips configured prefixes', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-routed-'));
    try {
      const productsPath = path.join(root, 'apps/web/src/locales/en/storefront/products.json');
      const categoryPath = path.join(root, 'apps/web/src/locales/en/admin/categoryManagement.json');
      fs.mkdirSync(path.dirname(productsPath), { recursive: true });
      fs.mkdirSync(path.dirname(categoryPath), { recursive: true });
      fs.writeFileSync(productsPath, JSON.stringify({ listing: { searchAction: 'Search' } }), 'utf8');
      fs.writeFileSync(categoryPath, JSON.stringify({ form: { name: 'Category Name' } }), 'utf8');

      const extractor = new Extractor(routedConfig(), root);
      const plans = extractor.planCatalogs([
        finding('products-existing', 'products.listing.searchAction', 'Search', 1),
        finding('products-new', 'products.listing.emptyTitle', 'Nothing here', 2),
        finding('category-existing', 'admin.categoryManagement.form.name', 'Category Name', 3),
        finding('category-new', 'admin.categoryManagement.form.helper', 'Choose a category', 4)
      ]);

      expect(plans).toHaveLength(2);
      const products = plans.find(plan => plan.namespace === 'products');
      const category = plans.find(plan => plan.namespace === 'admin.categoryManagement');
      expect(products?.keyByFindingId['products-existing']).toBe('products.listing.searchAction');
      expect(category?.keyByFindingId['category-existing']).toBe('admin.categoryManagement.form.name');
      expect(JSON.parse(products!.outputContent)).toEqual({
        listing: { emptyTitle: 'Nothing here', searchAction: 'Search' }
      });
      expect(JSON.parse(category!.outputContent)).toEqual({
        form: { helper: 'Choose a category', name: 'Category Name' }
      });
      expect(() => extractor.planCatalog([
        finding('products-another', 'products.listing.other', 'Other', 5),
        finding('category-another', 'admin.categoryManagement.form.other', 'Another', 6)
      ])).toThrow(/split-catalog/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('writes multiple routed catalogs as one validated write set', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-routed-write-'));
    try {
      const extractor = new Extractor(routedConfig(), root);
      const plans = extractor.planCatalogs([
        finding('product', 'products.listing.title', 'Products', 1),
        finding('category', 'admin.categoryManagement.titles.list', 'Categories', 2)
      ]);
      extractor.writePlans(plans);

      expect(JSON.parse(fs.readFileSync(
        path.join(root, 'apps/web/src/locales/en/storefront/products.json'),
        'utf8'
      ))).toEqual({ listing: { title: 'Products' } });
      expect(JSON.parse(fs.readFileSync(
        path.join(root, 'apps/web/src/locales/en/admin/categoryManagement.json'),
        'utf8'
      ))).toEqual({ titles: { list: 'Categories' } });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('never creates catalog entries for review-only semantic findings', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-review-only-'));
    try {
      const auditFinding = finding('fallback', 'products.actions.buyNow', 'Buy now', 1);
      auditFinding.kind = 'TranslationFallback';
      auditFinding.confidence = 'low';
      auditFinding.autoFixCandidate = false;
      auditFinding.fixability = 'review';
      auditFinding.fixStrategy = undefined;
      auditFinding.needsReview = true;

      const plan = new Extractor(routedConfig(), root).planCatalogs([auditFinding])[0];
      expect(plan.report.blockedFindings).toHaveLength(1);
      expect(plan.report.newEntries).toHaveLength(0);
      expect(plan.changed).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
