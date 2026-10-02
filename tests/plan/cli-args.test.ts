import { describe, it, expect } from 'vitest';
import { parseCliArgs } from '../../src/cli/args.js';

// Regression (batch-B closeout): node:util parseArgs keeps positionals in
// its OWN result field — `nova --replay-sessions <dir>` silently replayed
// the default home corpus because the positional never reached values._.

describe('parseCliArgs positional bag', () => {
  it('exposes positionals as _ (replay target case)', () => {
    const v = parseCliArgs(['--replay-sessions', 'C:/somewhere/sessions']);
    expect(v['replay-sessions']).toBe(true);
    expect(v._).toEqual(['C:/somewhere/sessions']);
  });

  it('keeps option values out of _', () => {
    const v = parseCliArgs(['-p', 'hello world', '--yes']);
    expect(v.print).toBe('hello world');
    expect(v.yes).toBe(true);
    expect(v._).toEqual([]);
  });

  it('collects multiple positionals in order', () => {
    const v = parseCliArgs(['alpha', '--model', 'm', 'beta']);
    expect(v.model).toBe('m');
    expect(v._).toEqual(['alpha', 'beta']);
  });
});
