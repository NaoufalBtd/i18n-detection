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

  it('deep-merges i18n and feature settings', () => {
    withTempFile(JSON.stringify({ i18n: { sourceLocale: 'fr' }, features: { codemod: true } }), filePath => {
      const config = loadConfig(filePath);
      expect(config.i18n.sourceLocale).toBe('fr');
      expect(config.i18n.library).toBe('next-intl');
      expect(config.features.codemod).toBe(true);
      expect(config.features.templateLiterals).toBe(true);
    });
  });
});
