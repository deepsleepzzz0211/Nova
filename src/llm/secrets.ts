import { execSync } from 'child_process';

/**
 * Secret value resolution DSL (pi-style Value Resolution).
 *
 * Supported forms:
 *  - `"!command"`      → execute as shell command, use trimmed stdout
 *  - `"$VAR"`          → environment variable (whole value or interpolated)
 *  - `"${VAR}text"`    → interpolation inside larger literals
 *  - `"$$..."`         → escape: emits a literal `$` (rest used verbatim)
 *  - `"$!..."`         → escape: emits a literal `!` (rest used verbatim)
 *  - anything else     → literal
 *
 * A missing environment variable makes the value unresolved (error).
 * Command execution can be disabled via allowCommands (then a `!` value
 * is an error instead of being run).
 */
export interface SecretResolveOptions {
  /** Allow `"!command"` execution. Default true. */
  allowCommands?: boolean;
  /** Timeout for command execution in ms. Default 10_000. */
  commandTimeoutMs?: number;
}

export function resolveSecretValue(value: string, options?: SecretResolveOptions): string {
  const allowCommands = options?.allowCommands ?? true;

  // Command execution
  if (value.startsWith('!')) {
    if (!allowCommands) {
      throw new Error('Secret command execution is disabled (allowCommands: false).');
    }
    const command = value.slice(1);
    try {
      const stdout = execSync(command, {
        encoding: 'utf-8',
        timeout: options?.commandTimeoutMs ?? 10_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const trimmed = stdout.trim();
      if (!trimmed) {
        throw new Error('command produced no output');
      }
      return trimmed;
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`Secret command failed: ${reason}`);
    }
  }

  // Escapes: "$$..." → literal "$...", "$!..." → literal "!..."
  if (value.startsWith('$$')) {
    return value.slice(1);
  }
  if (value.startsWith('$!')) {
    return value.slice(1);
  }

  // Environment interpolation: "$VAR", "${VAR}", inside larger literals too
  if (value.includes('$')) {
    return interpolateEnv(value);
  }

  // Literal
  return value;
}

/**
 * Replace `$NAME` and `${NAME}` sequences with environment variable values.
 * Missing variables make the whole value unresolved (error).
 */
function interpolateEnv(value: string): string {
  let result = '';
  let i = 0;

  while (i < value.length) {
    const char = value[i];
    if (char !== '$') {
      result += char;
      i++;
      continue;
    }

    // ${NAME} form (disambiguated)
    if (value[i + 1] === '{') {
      const close = value.indexOf('}', i + 2);
      if (close === -1) {
        // No closing brace: literal '$' + rest
        result += value[i];
        i++;
        continue;
      }
      const name = value.slice(i + 2, close);
      result += requireEnv(name);
      i = close + 1;
      continue;
    }

    // $NAME form: NAME = [A-Za-z_][A-Za-z0-9_]*
    const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(value.slice(i + 1));
    if (!match) {
      result += char;
      i++;
      continue;
    }
    result += requireEnv(match[0]);
    i += 1 + match[0].length;
  }

  return result;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined) {
    throw new Error(`Unresolved secret: environment variable ${name} is not set`);
  }
  return value;
}
