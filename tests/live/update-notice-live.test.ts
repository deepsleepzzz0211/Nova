/** LIVE e2e: real npm registry. Run via pnpm test:live */
import { describe, it, expect } from 'vitest';
import { checkForUpdate } from '../../src/update/update-check.js';

describe('LIVE update notice (real registry)', () => {
  it('detects 0.1.3 < 0.1.4 on production npm', async () => {
    const r = await checkForUpdate({ currentVersion: '0.1.3' });
    expect(r).toEqual({ latest: '0.1.4', updateAvailable: true });
  });

  it('silent when current is the latest', async () => {
    const r = await checkForUpdate({ currentVersion: '0.1.4' });
    expect(r).toBeNull();
  });
});
