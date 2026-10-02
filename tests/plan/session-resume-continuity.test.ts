import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  shouldContinueSessionFile,
  sessionFilePathForMode,
} from '../../src/cli/sessions.js';

// Review fix regression: --resume must CONTINUE the picked session file so
// the session id (and therefore ~/.nova/file-history/<sessionId>/) stays
// stable. Fresh runs keep the timestamped create semantics.

describe('session file continuity across --resume', () => {
  it('resume mode continues the picked file; fresh mode creates a new one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-cont-'));
    try {
      const picked = path.join(dir, 'session-2026-10-01T00-00-00-000Z.jsonl');
      fs.writeFileSync(picked, '', 'utf-8');

      expect(shouldContinueSessionFile(true)).toBe(true);
      const continued = sessionFilePathForMode(dir, picked, true);
      expect(continued).toBe(picked);

      const fresh = sessionFilePathForMode(dir, null, false);
      expect(fresh).not.toBe(picked);
      expect(path.basename(fresh)).toMatch(/^session-\d{4}-\d{2}-\d{2}T.*\.jsonl$/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the continued file yields the SAME session id (basename) before and after', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-id-'));
    try {
      const picked = path.join(dir, 'session-2026-10-01T00-00-00-000Z.jsonl');
      fs.writeFileSync(picked, '', 'utf-8');
      const before = path.basename(picked, '.jsonl');
      const after = path.basename(sessionFilePathForMode(dir, picked, true), '.jsonl');
      expect(after).toBe(before);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
