import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { loadConfig, ConfigError } from './config.js';

function withTempFile(content: string, callback: (filePath: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-config-'));
  const filePath = path.join(dir, 'config.json');
  fs.writeFileSync(filePath, content, 'utf8');
  try {
    callback(filePath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('configuration', () => {
  it('fails closed on malformed JSON', () => {
    withTempFile('{ invalid', filePath => {
      expect(() => loadConfig(filePath)).toThrow(ConfigError);
    });
  });

  it('fails on invalid runtime shapes', () => {
    withTempFile(JSON.stringify({ include: 'src/**/*.ts' }), filePath => {
      expect(() => loadConfig(filePath)).toThrow(/include must be an array of strings/);
    });
  });

  it('deep-merges i18n, semantic, and feature settings', () => {
    withTempFile(
      JSON.stringify({
        i18n: { sourceLocale: 'fr' },
        semantic: { scanNextMetadata: false },
        features: { codemod: true }
      }),
      filePath => {
        const config = loadConfig(filePath);
        expect(config.i18n.sourceLocale).toBe('fr');
        expect(config.i18n.library).toBe('next-intl');
        expect(config.semantic?.scanNextMetadata).toBe(false);
        expect(config.semantic?.scanValidationMessages).toBe(true);
        expect(config.features.codemod).toBe(true);
        expect(config.features.templateLiterals).toBe(true);
      }
    );
  });

  it('accepts deterministic split catalog routes', () => {
    withTempFile(
      JSON.stringify({
        i18n: {
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
      }),
      filePath => {
        const config = loadConfig(filePath);
        expect(config.i18n.catalogRoutes).toHaveLength(2);
        expect(config.i18n.catalogRoutes?.[0].namespace).toBe('products');
      }
    );
  });

  it('rejects duplicate or malformed catalog routes', () => {
    withTempFile(
      JSON.stringify({
        i18n: {
          catalogRoutes: [
            { namespace: 'products', messagesPath: 'one/{locale}.json' },
            { namespace: 'products', messagesPath: 'two/{locale}.json' }
          ]
        }
      }),
      filePath => {
        expect(() => loadConfig(filePath)).toThrow(/duplicate namespace 'products'/);
      }
    );
  });
});
