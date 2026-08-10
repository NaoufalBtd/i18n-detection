import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from './config.js';
import { Scanner } from './scanner.js';

describe('translation namespace inference', () => {
  it('uses one visible next-intl namespace before filesystem inference', () => {
    const scanner = new Scanner(DEFAULT_CONFIG);
    const report = scanner.scanInMemory('apps/web/src/storefront/features/product-detail/ProductPanel.tsx', `
      import { useTranslations } from 'next-intl';
      export function ProductPanel() {
        const t = useTranslations('ecommerce.productDetail');
        return <button title="Buy immediately">Buy now</button>;
      }
    `);
    const texts = report.findings.filter(item => item.rawText === 'Buy now' || item.rawText === 'Buy immediately');
    expect(texts).toHaveLength(2);
    expect(texts.every(item => item.suggestedKey?.startsWith('ecommerce.productDetail.'))).toBe(true);
  });

  it('walks outward from nested render callbacks to the owning component namespace', () => {
    const scanner = new Scanner(DEFAULT_CONFIG);
    const report = scanner.scanInMemory('apps/web/src/admin/features/category-management/CategoryList.tsx', `
      import { useTranslations } from 'next-intl';
      export function CategoryList() {
        const t = useTranslations('admin.categoryManagement');
        return <div>{[1].map(() => <span>Missing description</span>)}</div>;
      }
    `);
    const finding = report.findings.find(item => item.rawText === 'Missing description');
    expect(finding?.suggestedKey?.startsWith('admin.categoryManagement.')).toBe(true);
  });

  it('falls back to structural inference when multiple namespaces are visible', () => {
    const scanner = new Scanner(DEFAULT_CONFIG);
    const report = scanner.scanInMemory('apps/web/src/storefront/features/buyer-space/Panel.tsx', `
      import { useTranslations } from 'next-intl';
      export function Panel() {
        const t = useTranslations('account.orders');
        const tErrors = useTranslations('components.errors');
        return <span>Manual fallback</span>;
      }
    `);
    const finding = report.findings.find(item => item.rawText === 'Manual fallback');
    expect(finding?.suggestedKey?.startsWith('buyerSpace.')).toBe(true);
  });
});
