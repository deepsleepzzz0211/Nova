import { describe, it, expect } from 'vitest';
import {
  describeCall,
  dangerReason,
  SessionAlwaysRules,
} from '../../src/tui/permission-display.js';

describe('permission-display (tui-refactor 04)', () => {
  describe('describeCall', () => {
    it('bash shows the command string', () => {
      expect(describeCall('bash', { command: 'npm test' })).toBe('npm test');
    });

    it('path tools show the path', () => {
      expect(describeCall('read', { path: 'a.txt' })).toBe('a.txt');
      expect(describeCall('write', { path: 'a.txt' })).toBe('a.txt');
      expect(describeCall('edit', { file_path: 'b.txt' })).toBe('b.txt');
    });

    it('falls back to compact JSON, capped', () => {
      const r = describeCall('other', { a: 'x'.repeat(200) });
      expect(r.length).toBeLessThanOrEqual(83);
    });

    it('unparseable args fall back to the raw string', () => {
      // describeCall takes parsed args; null renders the raw fallback
      expect(describeCall('weird', null)).toBe('(unparseable arguments)');
    });
  });

  describe('dangerReason', () => {
    it('flags dangerous bash commands with the reason', () => {
      expect(dangerReason('bash', { command: 'rm -rf /tmp/x' })).toBe('Recursive file deletion');
      expect(dangerReason('bash', { command: 'sudo apt install' })).toBe('Elevated privileges');
    });

    it('non-bash tools are never dangerous (no hardcoded bash literal here)', () => {
      expect(dangerReason('write', { path: '/etc/passwd' })).toBeNull();
      expect(dangerReason('read', { path: 'x' })).toBeNull();
    });

    it('safe bash commands pass', () => {
      expect(dangerReason('bash', { command: 'ls -la' })).toBeNull();
    });
  });

  describe('SessionAlwaysRules', () => {
    it('matches the same tool + same primary argument', () => {
      const rules = new SessionAlwaysRules();
      rules.add('bash', { command: 'npm test' });
      expect(rules.matches('bash', { command: 'npm test' })).toBe(true);
      expect(rules.matches('bash', { command: 'npm run build' })).toBe(false);
      expect(rules.matches('read', { path: 'npm test' })).toBe(false);
    });

    it('matches path tools by their path', () => {
      const rules = new SessionAlwaysRules();
      rules.add('read', { path: 'src/loop.ts' });
      expect(rules.matches('read', { path: 'src/loop.ts' })).toBe(true);
      expect(rules.matches('read', { path: 'src/other.ts' })).toBe(false);
    });

    it('unparseable-argument calls match only their tool-wide exact rule', () => {
      const rules = new SessionAlwaysRules();
      rules.add('weird', null);
      expect(rules.matches('weird', null)).toBe(true);
      expect(rules.matches('weird', { a: 1 })).toBe(false);
    });

    it('empty rules match nothing', () => {
      const rules = new SessionAlwaysRules();
      expect(rules.matches('bash', { command: 'ls' })).toBe(false);
    });
  });
});
