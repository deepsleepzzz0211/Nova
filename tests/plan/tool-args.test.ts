import { describe, it, expect } from 'vitest';
import { extractPathArg } from '../../src/shared/tool-args.js';

// PR #108 code review: the `JSON.parse(call.function.arguments) as { path }`
// shape recurred in three hunks; one shared extractor owns it.

describe('extractPathArg', () => {
  it('returns the string path argument', () => {
    expect(extractPathArg('{"path":"a.ts"}')).toBe('a.ts');
    expect(extractPathArg('{"path":"C:\\\\temp\\\\x","content":"y"}')).toBe('C:\\temp\\x');
  });

  it('returns null on non-JSON, missing path, or non-string path', () => {
    expect(extractPathArg('{ not json')).toBeNull();
    expect(extractPathArg('{"command":"ls"}')).toBeNull();
    expect(extractPathArg('{"path":42}')).toBeNull();
    expect(extractPathArg('{"path":null}')).toBeNull();
  });
});
