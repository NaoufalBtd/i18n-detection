import { bench, describe } from 'vitest';
import { DEFAULT_CONFIG } from './config.js';
import { Scanner } from './scanner.js';

function buildLargeSemanticFixture(registries = 100, states = 50): string {
  const registrySource = Array.from({ length: registries }, (_, index) => `
    export const REGISTRY_${index}_OPTIONS = [
      { value: 'one', label: 'Option ${index} One', description: 'Description for option ${index} one' },
      { value: 'two', label: 'Option ${index} Two', description: 'Description for option ${index} two' }
    ] as const;
  `).join('\n');

  const stateSource = Array.from({ length: states }, (_, index) => `
    export function Panel${index}() {
      const [message${index}, setMessage${index}] = useState('');
      const fail${index} = () => setMessage${index}('Customer-facing state message ${index}');
      return <button onClick={fail${index}}>{message${index}}</button>;
    }
  `).join('\n');

  return `
    import { useState } from 'react';
    ${registrySource}
    ${stateSource}
  `;
}

describe('semantic scanner performance', () => {
  const fixture = buildLargeSemanticFixture();

  bench('indexed semantic scan across registry and state-heavy source', () => {
    const report = new Scanner(DEFAULT_CONFIG).scanInMemory(
      'packages/contracts/src/semantic-performance.tsx',
      fixture
    );
    if (report.summary.totalFindings === 0) throw new Error('benchmark fixture produced no findings');
  });
});
