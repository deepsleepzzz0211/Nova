import { describe, it, expect, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { novaHome } from '../../src/config/loader.js';

describe('novaHome', () => {
  const saved = process.env.NOVA_HOME;

  afterEach(() => {
    if (saved === undefined) delete process.env.NOVA_HOME;
    else process.env.NOVA_HOME = saved;
  });

  it('defaults to os.homedir()', () => {
    delete process.env.NOVA_HOME;
    expect(novaHome()).toBe(os.homedir());
  });

  it('honors the NOVA_HOME override (test isolation / portable installs)', () => {
    process.env.NOVA_HOME = '/tmp/nova-home-override';
    expect(novaHome()).toBe('/tmp/nova-home-override');
  });
});
