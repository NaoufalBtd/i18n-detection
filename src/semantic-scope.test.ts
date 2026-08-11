import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from './config.js';
import { Scanner } from './scanner.js';
import type { ScannerConfig } from './types.js';

function webOnlySemanticConfig(): ScannerConfig {
  return {
    ...DEFAULT_CONFIG,
    semantic: {
      ...DEFAULT_CONFIG.semantic!,
      presentationInclude: ['apps/web/'],
      validationInclude: ['apps/web/'],
      staticRegistryInclude: ['apps/web/']
    }
  };
}

describe('semantic source scopes', () => {
  it('does not apply web presentation heuristics to backend presenter-like files', () => {
    const report = new Scanner(webOnlySemanticConfig()).scanInMemory(
      'apps/backend/src/payment/presentation/payment-adapter.ts',
      `
        export function getPaymentPresentation() {
          return {
            label: 'Stripe payment adapter',
            description: 'Internal payment integration metadata'
          };
        }
      `
    );

    expect(report.findings.some(finding => finding.kind === 'PresentationObjectString')).toBe(false);
  });

  it('does not apply web validation-message policy to backend Zod schemas outside the configured scope', () => {
    const report = new Scanner(webOnlySemanticConfig()).scanInMemory(
      'apps/backend/src/modules/user/auth.schema.ts',
      `
        import { z } from 'zod';
        export const InternalAuthSchema = z.object({
          token: z.string().min(1, 'Internal security token is required')
        });
      `
    );

    expect(report.findings.some(finding => finding.kind === 'ValidationMessage')).toBe(false);
  });
});
