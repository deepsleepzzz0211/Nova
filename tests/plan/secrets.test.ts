import { describe, it, expect } from 'vitest';
import { resolveSecretValue } from '../../src/llm/secrets.js';

describe('resolveSecretValue (value resolution DSL)', () => {
  it('returns plain literals untouched', () => {
    expect(resolveSecretValue('sk-abc123')).toBe('sk-abc123');
    expect(resolveSecretValue('ollama')).toBe('ollama');
  });

  it('resolves $VAR and ${VAR} from the environment', () => {
    process.env.NOVA_TEST_SECRET = 's3cr3t';
    try {
      expect(resolveSecretValue('$NOVA_TEST_SECRET')).toBe('s3cr3t');
      expect(resolveSecretValue('${NOVA_TEST_SECRET}')).toBe('s3cr3t');
      // Interpolation inside larger literals
      expect(resolveSecretValue('${NOVA_TEST_SECRET}_suffix')).toBe('s3cr3t_suffix');
      expect(resolveSecretValue('pre-${NOVA_TEST_SECRET}-post')).toBe('pre-s3cr3t-post');
    } finally {
      delete process.env.NOVA_TEST_SECRET;
    }
  });

  it('distinguishes $FOO_BAR as variable FOO_BAR', () => {
    process.env.NOVA_TEST_SECRET = 'v';
    process.env.NOVA_TEST_SECRET_BAR = 'should-not-match';
    try {
      // $NOVA_TEST_SECRET_BAR matches the longer name; $NOVA_TEST_SECRET + "_BAR" literal
      expect(resolveSecretValue('$NOVA_TEST_SECRET_BAR')).toBe('should-not-match');
      expect(resolveSecretValue('$NOVA_TEST_SECRET_BAR')).not.toBe('v_BAR');
      expect(resolveSecretValue('${NOVA_TEST_SECRET}_BAR')).toBe('v_BAR');
    } finally {
      delete process.env.NOVA_TEST_SECRET;
      delete process.env.NOVA_TEST_SECRET_BAR;
    }
  });

  it('errors on missing environment variables', () => {
    expect(() => resolveSecretValue('$NOVA_DEFINITELY_NOT_SET_XYZ')).toThrow(/NOVA_DEFINITELY_NOT_SET_XYZ/);
  });

  it('treats a literal dollar followed by non-name chars as text', () => {
    expect(resolveSecretValue('costs $5 and $10')).toBe('costs $5 and $10');
    // $b IS a variable reference per the DSL semantics → unresolved
    expect(() => resolveSecretValue('a$b')).toThrow(/environment variable b/);
  });

  it('executes !command and uses trimmed stdout', () => {
    const result = resolveSecretValue('!echo hello-secret');
    expect(result).toBe('hello-secret');
  });

  it('errors when the secret command fails or outputs nothing', () => {
    expect(() => resolveSecretValue('!exit 3')).toThrow(/Secret command failed/);
    expect(() => resolveSecretValue('!true')).toThrow(/Secret command failed/); // empty stdout
  });

  it('can disable command execution', () => {
    expect(() => resolveSecretValue('!echo hi', { allowCommands: false })).toThrow(/disabled/);
  });

  it('supports escapes: $$ and $! emit literal prefixes', () => {
    expect(resolveSecretValue('$$literal-dollar')).toBe('$literal-dollar');
    expect(resolveSecretValue('$!bang')).toBe('!bang');
  });
});
