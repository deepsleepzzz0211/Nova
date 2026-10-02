import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  parseUserCommandFile,
  expandUserCommand,
  loadUserCommands,
  type UserCommand,
} from '../../src/commands/user-commands.js';
import { findCommand, reportClashOnce } from '../../src/tui/commands.js';

// Batch-B ticket 04: user-defined slash commands from ~/.nova/commands/*.md.
// Front-matter carries metadata; the body is a prompt template with $1..$9 /
// $ARGUMENTS slots. Dispatch sends the EXPANDED text down the normal user
// message path; built-ins always win a name clash.

describe('parseUserCommandFile', () => {
  it('reads front-matter metadata and the template body', () => {
    const cmd = parseUserCommandFile(
      'summarize-changes.md',
      '---\ndescription: summarize a diff\nargument_hint: <path>\n---\nLook at $1 and summarize the changes.\n',
    );
    expect(cmd).toMatchObject({
      name: 'summarize-changes',
      description: 'summarize a diff',
      argumentHint: '<path>',
    });
    expect(cmd!.template).toBe('Look at $1 and summarize the changes.');
  });

  it('tolerates CRLF and missing front-matter (whole file is the template)', () => {
    const cmd = parseUserCommandFile('plain.md', 'just a template $ARGUMENTS\r\nsecond line\r\n');
    expect(cmd!.description).toBe('');
    expect(cmd!.template).toBe('just a template $ARGUMENTS\nsecond line');
  });

  it('rejects an empty body and invalid names', () => {
    expect(parseUserCommandFile('empty.md', '---\ndescription: x\n---\n  \n')).toBeNull();
    expect(parseUserCommandFile('Bad Name.md', 'body')).toBeNull();
    expect(parseUserCommandFile('-leading.md', 'body')).toBeNull();
  });
});

describe('expandUserCommand', () => {
  it('fills positional and $ARGUMENTS slots', () => {
    expect(expandUserCommand('a $1 b $2 c', 'first "two words"')).toBe('a first b two words c');
    expect(expandUserCommand('run on $ARGUMENTS', 'x y z')).toBe('run on x y z');
  });

  it('leaves unfilled placeholders as-is', () => {
    expect(expandUserCommand('$1 and $2', 'only-one')).toBe('only-one and $2');
    expect(expandUserCommand('$ARGUMENTS!', '')).toBe('$ARGUMENTS!');
  });
});

describe('loadUserCommands', () => {
  let dir: string;
  const warnings: string[] = [];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucmds-'));
    warnings.length = 0;
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('loads sorted .md commands, skips other files and warns on invalid', () => {
    fs.writeFileSync(path.join(dir, 'zebra.md'), 'z body');
    fs.writeFileSync(path.join(dir, 'alpha.md'), '---\ndescription: a\n---\na body');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignore me');
    fs.writeFileSync(path.join(dir, 'Broke.md'), 'bad name body');
    const cmds = loadUserCommands(dir, (m) => warnings.push(m));
    expect(cmds.map((c) => c.name)).toEqual(['alpha', 'zebra']);
    expect(warnings.join('\n')).toMatch(/Broke\.md/);
  });

  it('missing directory yields an empty list without throwing', () => {
    expect(loadUserCommands(path.join(dir, 'nope'))).toEqual([]);
  });
});

describe('findCommand with user commands', () => {
  const user: UserCommand = {
    name: 'deploy',
    description: 'deploy it',
    template: 'deploy $ARGUMENTS please',
  };

  it('resolves user commands when a list is provided', () => {
    const found = findCommand('/deploy staging', [user]);
    expect(found).not.toBeNull();
    expect(found!.user).toMatchObject({ name: 'deploy' });
    expect(found!.args).toBe('staging');
  });

  it('built-ins win a name clash and the override is reported once', () => {
    const clashes: string[] = [];
    const shadow: UserCommand = { ...user, name: 'compact', template: 't' };
    const found = findCommand('/compact', [shadow], (m) => clashes.push(m));
    expect(found!.command?.name).toBe('compact');
    expect(found!.user).toBeUndefined();
    expect(clashes.join('')).toMatch(/compact/);
  });

  it('without the optional argument, behavior matches the built-in registry only', () => {
    expect(findCommand('/deploy x')?.command?.name).toBeUndefined();
    expect(findCommand('/deploy x')).toBeNull();
    expect(findCommand('/model')!.command?.name).toBe('model');
  });
});

describe('reportClashOnce (ticket 04 shadow warning)', () => {
  it('writes each distinct message once to stderr, never stdout', () => {
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const msgA = `[commands] shadow-A-${Date.now()}`;
      const msgB = `[commands] shadow-B-${Date.now()}`;
      reportClashOnce(msgA);
      reportClashOnce(msgA);
      reportClashOnce(msgB);
      const written = errSpy.mock.calls.map((c) => String(c[0]));
      expect(written.filter((t) => t.includes(msgA))).toHaveLength(1);
      expect(written.filter((t) => t.includes(msgB))).toHaveLength(1);
      expect(outSpy.mock.calls.map((c) => String(c[0])).some((t) => t.includes(msgA))).toBe(false);
    } finally {
      errSpy.mockRestore();
      outSpy.mockRestore();
    }
  });
});
