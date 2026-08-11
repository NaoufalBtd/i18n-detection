import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from './config.js';
import { Scanner } from './scanner.js';

describe('conditional object UI flow', () => {
  it('traces hardcoded template variants through a conditional object into a known component prop', () => {
    const scanner = new Scanner(DEFAULT_CONFIG);
    const report = scanner.scanInMemory('apps/web/src/admin/AssetDetailsDrawer.tsx', `
      declare const usageData: { total: number };
      declare const pendingAction: 'replace' | 'archive' | 'delete';
      declare const t: any;
      declare function ConfirmDialog(props: { message: string }): any;

      export function AssetDetailsDrawer() {
        const confirmation =
          pendingAction === 'replace'
            ? {
                title: t.confirm.replaceTitle,
                message: \`${'${'}t.confirm.replaceMessage} This asset has ${'${'}usageData.total} known usages.\`,
                label: t.confirm.replaceConfirm,
              }
            : pendingAction === 'archive'
              ? {
                  title: t.confirm.archiveTitle,
                  message: \`${'${'}t.confirm.archiveMessage} This asset has ${'${'}usageData.total} known usages.\`,
                  label: t.actions.archive,
                }
              : {
                  title: t.confirm.deleteTitle,
                  message:
                    usageData.total > 0
                      ? \`${'${'}t.confirm.deleteMessage} ${'${'}t.confirm.deleteUsedWarning}\`
                      : t.confirm.deleteMessage,
                  label: t.actions.delete,
                };
        return <ConfirmDialog message={confirmation.message} />;
      }
    `);

    const finding = report.findings.find(item => item.userFacingContext?.propName === 'message');
    expect(finding?.kind).toBe('ConditionalStringUsedInUserFacingContext');
    expect(finding?.confidence).toBe('medium');
    const texts = finding?.texts ?? [];
    expect(texts.filter(text => text.includes('This asset has') && text.includes('known usages.')).length).toBeGreaterThanOrEqual(2);
    expect(finding?.autoFixCandidate).toBe(false);
  });
});
