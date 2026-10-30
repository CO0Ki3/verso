import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { envFile, helperFile } from '../src/init.ts';

describe('helperFile', () => {
  it('imports the helpers from verso and defines an Expect gated by the key', () => {
    const file = helperFile('@scope/lib', false);
    expect(file).toContain("import type { Gate } from 'verso';");
    expect(file).toContain("export type { Equal, Extends, GuardOf, NotEqual, NotExtends } from 'verso';");
    expect(file).toContain("export type Expect<T extends Gate<'@scope/lib'>> = T;");
  });

  it('copies the helper definitions with standalone, without the blocks that check them', () => {
    const file = helperFile('lib', true);
    const source = readFileSync(join(import.meta.dirname, '../src/index.ts'), 'utf8');
    expect(file.startsWith(source.slice(0, source.indexOf('\n// End of the helpers.') + 1))).toBe(true);
    expect(file).not.toContain('@verso');
    expect(file).not.toMatch(/^(?:import|export .* from)\b/m);
    expect(file).toContain("export type Expect<T extends Gate<'lib'>> = T;");
  });

  it('escapes quotes and backslashes in the key', () => {
    expect(helperFile("it's\\", false)).toContain("Gate<'it\\'s\\\\'>");
  });
});

describe('envFile', () => {
  it('declares a global VersoEnabled with the key, without imports or exports', () => {
    const file = envFile('@scope/lib');
    expect(file).toContain("interface VersoEnabled {\n  '@scope/lib': true;\n}");
    expect(file).not.toMatch(/^(?:import|export)\b/m);
  });
});
