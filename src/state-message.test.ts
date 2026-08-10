import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from './config.js';
import { Scanner } from './scanner.js';

describe('state message flow', () => {
  it('detects hardcoded copy stored in state when the state is rendered', () => {
    const scanner = new Scanner(DEFAULT_CONFIG);
    const report = scanner.scanInMemory('apps/web/src/storefront/ProductPurchaseIsland.tsx', `
      import { useState } from 'react';
      export function ProductPurchaseIsland() {
        const [statusMessage, setStatusMessage] = useState('');
        const fail = () => setStatusMessage('We could not add this item. Please try again.');
        return <div><button onClick={fail}>Retry</button>{statusMessage ? <p>{statusMessage}</p> : null}</div>;
      }
    `);
    const finding = report.findings.find(item => item.userFacingContext?.type === 'StateMessage');
    expect(finding?.rawText).toBe('We could not add this item. Please try again.');
    expect(finding?.confidence).toBe('medium');
    expect(finding?.autoFixCandidate).toBe(false);
  });

  it('does not treat internal state strings as UI copy when the state is never rendered', () => {
    const scanner = new Scanner(DEFAULT_CONFIG);
    const report = scanner.scanInMemory('apps/web/src/model/InternalState.tsx', `
      import { useState } from 'react';
      export function InternalState() {
        const [phase, setPhase] = useState('idle');
        const start = () => setPhase('background-processing');
        return <button onClick={start}>Start</button>;
      }
    `);
    expect(report.findings.some(item => item.userFacingContext?.type === 'StateMessage')).toBe(false);
  });
});
