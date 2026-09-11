import { describe, it, expect } from 'vitest';
import {
  describeCall,
  dangerReason,
  SessionAlwaysRules,
} from '../../src/tui/permission-display.js';

function kindOf(name: string): 'command' | 'path' | undefined {
  if (name === 'bash') return 'command';
  if (name === 'read_file' || name === 'write_file' || name === 'edit_file') return 'path';
  return undefined;
}

describe('permission-display (tui-refactor 04)', () => {
  describe('describeCall', () => {
    it('bash shows the command string', () => {
      expect(describeCall('bash', { command: 'npm test' }, kindOf)).toBe('npm test');
    });

    it('path tools show the path', () => {
      expect(describeCall('read_file', { path: 'a.txt' }, kindOf)).toBe('a.txt');
      expect(describeCall('write_file', { path: 'a.txt' }, kindOf)).toBe('a.txt');
      expect(describeCall('read_file', { path: 'b.txt' }, kindOf)).toBe('b.txt');
    });

    it('falls back to compact JSON, capped at 200', () => {
      const r = describeCall('other', { a: 'x'.repeat(400) }, kindOf);
      expect(r.length).toBeLessThanOrEqual(203);
    });
    it('keeps command tails visible up to the 200-char cap', () => {
      const head = 'echo ok && ';
      const tail = 'y'.repeat(150);
      const r = describeCall('bash', { command: head + tail }, kindOf);
      expect(r).toContain('&&');
      expect(r.length).toBeLessThanOrEqual(203);
    });

    it('unparseable args fall back to the raw string', () => {
      // describeCall takes parsed args; null renders the raw fallback
      expect(describeCall('weird', null, kindOf)).toBe('(unparseable arguments)');
    });
  });

  describe('dangerReason', () => {
    it('flags dangerous bash commands with the reason', () => {
      expect(dangerReason('bash', { command: 'rm -rf /tmp/x' }, kindOf)).toBe('Recursive file deletion');
      expect(dangerReason('bash', { command: 'sudo apt install' }, kindOf)).toBe('Elevated privileges');
    });

    it('non-bash tools are never dangerous (no hardcoded bash literal here)', () => {
      expect(dangerReason('write_file', { path: '/etc/passwd' }, kindOf)).toBeNull();
      expect(dangerReason('read_file', { path: 'x' }, kindOf)).toBeNull();
    });

    it('safe bash commands pass', () => {
      expect(dangerReason('bash', { command: 'ls -la' }, kindOf)).toBeNull();
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
