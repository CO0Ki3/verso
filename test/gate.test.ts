import { describe, expect, it } from 'vitest';

import { enabledKeys, ENV_FILE, gatedKeys } from '../src/gate.ts';
import { envFile, helperFile } from '../src/init.ts';

describe('enabledKeys', () => {
  it('reads the keys of every VersoEnabled declaration', () => {
    const source = [
      'interface VersoEnabled {',
      "  '@scope/lib': true;",
      '  plain: true;',
      '  "double": true;',
      '  optional?: true;',
      '  readonly guarded: true;',
      '  nested: { inner: true };',
      '}',
      '// interface VersoEnabled { commented: true }',
      'declare global {',
      '  interface VersoEnabled { global: true }',
      '}',
      'interface Other { other: true }',
    ].join('\n');
    expect(enabledKeys(source)).toEqual(['@scope/lib', 'plain', 'double', 'optional', 'guarded', 'nested', 'global']);
  });

  it('skips declarations that do not merge with the global interface', () => {
    const block = "interface VersoEnabled { 'local': true }";
    expect(enabledKeys(`export {};\n${block}`)).toEqual([]);
    expect(enabledKeys(`import type { Gate } from 'verso';\n${block}`)).toEqual([]);
    expect(enabledKeys(`export ${block}`)).toEqual([]);
    expect(enabledKeys(`declare namespace N { ${block} }`)).toEqual([]);
    expect(enabledKeys(`export {};\ndeclare global { ${block} }`)).toEqual(['local']);
    expect(enabledKeys(`type Lazy = import('verso').Gate<'x'>;\n${block}`)).toEqual(['local']);
  });

  it('reads what `verso init` writes', () => {
    expect(enabledKeys(envFile("it's \\ tricky"))).toEqual(["it\\'s \\\\ tricky"]);
    expect(enabledKeys(envFile('@scope/lib'))).toEqual(['@scope/lib']);
  });
});

describe('gatedKeys', () => {
  it('reads the key of each gated Expect definition with its line', () => {
    const source = [
      "type Expect<T extends Gate<'a'>> = T;",
      '',
      'export type Expect<Value extends Gate<"b">> = Value;',
    ].join('\n');
    expect(gatedKeys(source)).toEqual([
      { key: 'a', line: 1 },
      { key: 'b', line: 3 },
    ]);
  });

  it('ignores the Gate definition, other uses of Gate and comments', () => {
    const source = [
      'export type Gate<Key extends string> = Key extends keyof VersoEnabled ? true : unknown;',
      "declare type _gate = [Expect<Equal<Gate<'other'>, unknown>>];",
      "// type Expect<T extends Gate<'commented'>> = T;",
    ].join('\n');
    expect(gatedKeys(source)).toEqual([]);
  });

  it('reads what `verso init` writes', () => {
    expect(gatedKeys(helperFile('@scope/lib', false)).map(({ key }) => key)).toEqual(['@scope/lib']);
    expect(gatedKeys(helperFile('@scope/lib', true)).map(({ key }) => key)).toEqual(['@scope/lib']);
  });
});

describe('ENV_FILE', () => {
  it('matches verso.env.d.ts in any directory, and nothing else', () => {
    expect(
      ['/p/src/verso.env.d.ts', 'verso.env.d.ts', 'C:\\p\\verso.env.d.ts'].every((path) => ENV_FILE.test(path)),
    ).toBe(true);
    // A .d.mts or .d.cts file is always a module, so its interface could not enable anything.
    const others = ['/p/src/myverso.env.d.ts', '/p/src/verso.env.ts', '/p/verso.env.d.mts', '/p/verso.env.d.cts'];
    expect(others.some((path) => ENV_FILE.test(path))).toBe(false);
  });
});
