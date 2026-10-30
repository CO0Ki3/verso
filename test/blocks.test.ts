import { describe, expect, it } from 'vitest';

import { parseBlocks } from '../src/blocks.ts';

const lines = (...source: string[]): string => source.join('\n');
const problems = (...source: string[]): string[] =>
  parseBlocks(lines(...source)).problems.map(({ line, message }) => `${line}: ${message}`);
const nocheck = (line: number): string =>
  `${line}: \`@ts-nocheck\` makes tsc skip this file, so its blocks check nothing`;

describe('parseBlocks', () => {
  it('reads a block from its marker to the end of its declaration', () => {
    const source = lines(
      "import type { Equal, Expect } from './verso.ts';",
      '',
      'export const one = 1;',
      '',
      '// @verso one',
      'declare type _one = [',
      '  Expect<Equal<typeof one, 1>>,',
      '  // Not widened.',
      '  Expect<NotEqual<typeof one, number>>,',
      '];',
    );
    expect(parseBlocks(source)).toEqual({
      blocks: [{ name: 'one', line: 5, endLine: 10, assertions: 2 }],
      problems: [],
    });
  });

  it('skips blank lines and comments between the marker and the declaration', () => {
    const source = lines(
      '// @verso gap',
      '',
      '// why this block exists',
      '/* more */',
      'declare type _gap = [Expect<true>];',
    );
    expect(parseBlocks(source).blocks).toEqual([{ name: 'gap', line: 1, endLine: 5, assertions: 1 }]);
  });

  it('keeps every word after the marker as the name', () => {
    const source = lines('//   @verso   isDate narrows unknown  ', 'declare type _x = [Expect<true>];');
    expect(parseBlocks(source).blocks[0]?.name).toBe('isDate narrows unknown');
  });

  it('reads several blocks in one file', () => {
    const source = lines(
      '// @verso a',
      'declare type _a = [Expect<true>];',
      '// @verso b',
      'declare type _b = [',
      '  Expect<true>,',
      '];',
    );
    expect(parseBlocks(source).blocks).toEqual([
      { name: 'a', line: 1, endLine: 2, assertions: 1 },
      { name: 'b', line: 3, endLine: 6, assertions: 1 },
    ]);
  });

  it('ignores markers inside strings, template literals and block comments', () => {
    const source = lines(
      'const fixture = `',
      '// @verso in template',
      'declare type _t = [Expect<true>];',
      '`;',
      "const text = '// @verso in string';",
      '/*',
      '// @verso in comment',
      '*/',
    );
    expect(parseBlocks(source)).toEqual({ blocks: [], problems: [] });
  });

  it('is not confused by brackets in string literal, template literal and object types', () => {
    const source = lines(
      '// @verso literals',
      'declare type _literals = [',
      "  Expect<Equal<Lower<']'>, ']'>>,",
      '  Expect<Equal<`[${string}`, `[${string}`>>,',
      '  Expect<Equal<{ a: [1, (b: 2) => void] }, { a: [1, (b: 2) => void] }>>,',
      '];',
      'export const after = 1;',
    );
    expect(parseBlocks(source).blocks).toEqual([{ name: 'literals', line: 1, endLine: 6, assertions: 3 }]);
  });

  it('ends a block without `;` at the tuple when the next statement starts on a new line', () => {
    const source = lines('// @verso asi', 'declare type _asi = [', '  Expect<true>,', ']', 'export const after = 1');
    expect(parseBlocks(source).blocks).toEqual([{ name: 'asi', line: 1, endLine: 4, assertions: 1 }]);
  });

  it('ends a block without `;` at the end of the file', () => {
    expect(parseBlocks(lines('// @verso eof', 'declare type _eof = [Expect<true>]')).blocks).toHaveLength(1);
  });

  it('reads CRLF sources', () => {
    const source = ['// @verso crlf', 'declare type _crlf = [', '  Expect<true>,', '];'].join('\r\n');
    expect(parseBlocks(source).blocks).toEqual([{ name: 'crlf', line: 1, endLine: 4, assertions: 1 }]);
  });

  it('counts `Expect` only where it takes type arguments', () => {
    const source = lines('// @verso count', 'declare type _count = [', '  Expect<Equal<Expect<true>, true>>,', '];');
    expect(parseBlocks(source).blocks[0]?.assertions).toBe(2);
  });

  describe('reports malformed blocks', () => {
    it('exported aliases', () => {
      expect(problems('// @verso x', 'export declare type _x = [Expect<true>];')).toEqual([
        '1: a block must not be exported, or it would leak into declaration output',
      ]);
    });

    it('plain type aliases', () => {
      expect(problems('// @verso x', 'type _x = [Expect<true>];')).toEqual([
        '1: use `declare type`: a plain type alias that is never used fails `noUnusedLocals` (TS6196)',
      ]);
    });

    it('anything but a type alias', () => {
      expect(problems('// @verso x', 'export function x() {}')).toEqual([
        '1: the marker must be followed by `declare type _name = [ ... ];`',
      ]);
      expect(problems('// @verso x', 'declare const _x: [Expect<true>];')).toEqual([
        '1: the marker must be followed by `declare type _name = [ ... ];`',
      ]);
      expect(problems('// @verso x')).toEqual(['1: the marker must be followed by `declare type _name = [ ... ];`']);
    });

    it('alias names without a leading underscore', () => {
      expect(problems('// @verso x', 'declare type x = [Expect<true>];')).toEqual([
        "1: the alias name must start with `_` so that unused-variable lint rules skip it: 'x'",
      ]);
    });

    it('type parameters', () => {
      expect(problems('// @verso x', 'declare type _x<T> = [Expect<true>];')).toEqual([
        '1: the block alias must not take type parameters',
      ]);
    });

    it('bodies that are not a tuple', () => {
      expect(problems('// @verso x', 'declare type _x = Expect<true>;')).toEqual([
        '1: the block body must be a tuple of assertions: `= [ ... ];`',
      ]);
      expect(problems('// @verso x', 'declare type _x = [Expect<true>] | [];')).toEqual([
        '1: the block body must be a single tuple: end it with `;` right after `]`',
      ]);
      expect(problems('// @verso x', 'declare type _x = [Expect<true>]', '  | [];')).toEqual([
        '1: the block body must be a single tuple: end it with `;` right after `]`',
      ]);
    });

    it('blocks without assertions', () => {
      expect(problems('// @verso x', 'declare type _x = [];')).toEqual(['1: the block has no `Expect<...>` assertion']);
    });

    it('unclosed and unbalanced tuples', () => {
      expect(problems('// @verso x', 'declare type _x = [', '  Expect<true>,')).toEqual([
        '1: the block tuple is never closed',
      ]);
      expect(problems('// @verso x', 'declare type _x = [Expect<(true]>)];')).toEqual([
        '1: the block has unbalanced brackets',
      ]);
    });

    it('markers that do not stand on their own line', () => {
      expect(problems('const a = 1; // @verso x', 'declare type _x = [Expect<true>];')).toEqual([
        '1: the `// @verso` marker must be on a line of its own',
      ]);
    });

    it('markers without a name', () => {
      expect(problems('// @verso', 'declare type _x = [Expect<true>];')).toEqual([
        '1: the marker needs a block name: `// @verso <name>`',
      ]);
    });

    it('a marker followed by another marker', () => {
      expect(problems('// @verso x', '// @verso y', 'declare type _y = [Expect<true>];')).toEqual([
        '1: the marker is not followed by a declaration',
      ]);
    });

    it('markers inside a block', () => {
      expect(problems('// @verso x', 'declare type _x = [', '  // @verso y', '  Expect<true>,', '];')).toEqual([
        '1: a `// @verso` marker cannot appear inside a block',
        '3: the marker must be followed by `declare type _name = [ ... ];`',
      ]);
    });

    it('`@ts-expect-error` right above an assertion, which breaks where the gate turns `Expect` off', () => {
      expect(
        problems(
          '// @verso x',
          'declare type _x = [',
          '  // @ts-expect-error not equal',
          '  Expect<Equal<1, 2>>,',
          '  /* @ts-expect-error */ Expect<Equal<1, 2>>,',
          "  // @ts-expect-error 'b' is not a key",
          "  Pick<{ a: 1 }, 'b'>,",
          '];',
        ),
      ).toEqual(
        [3, 5].map(
          (line) =>
            `${line}: a \`@ts-expect-error\` negative breaks in consumers, where the gate turns \`Expect\` off; ` +
            'write `Expect<NotEqual<...>>` or `Expect<NotExtends<...>>` instead',
        ),
      );
      expect(
        parseBlocks(lines('// @verso x', 'declare type _x = [', '  // @ts-expect-error', '  Expect<true>,', '];'))
          .blocks,
      ).toHaveLength(1);
    });

    it('duplicate names within a file', () => {
      expect(
        problems(
          '// @verso x',
          'declare type _a = [Expect<true>];',
          '// @verso x',
          'declare type _b = [Expect<true>];',
        ),
      ).toEqual(["3: the block name 'x' is already used on line 1"]);
    });
  });

  describe('reports imports of the helpers that survive in JS output', () => {
    it('anything but a whole-statement `import type` or `export type`', () => {
      expect(
        problems(
          "import { type Equal, type Expect } from 'verso-ts';",
          'import * as verso from "verso-ts";',
          "import 'verso-ts';",
          "export { type Equal } from 'verso-ts';",
          "export * from 'verso-ts';",
        ),
      ).toEqual(
        [1, 2, 3, 4, 5].map(
          (line) =>
            `${line}: use \`${line < 4 ? 'import' : 'export'} type\` for 'verso-ts': under \`verbatimModuleSyntax\` any other form stays in the JS output`,
        ),
      );
    });

    it('but not type-only declarations, other modules or lookalikes', () => {
      expect(
        problems(
          "import type { Equal, Expect } from 'verso-ts';",
          "export type { Equal } from 'verso-ts';",
          "export type * from 'verso-ts';",
          "import { from } from './verso.ts';",
          "import { type Expect } from './verso.ts';",
          "export const from = 'verso';",
          "type Lazy = import('verso-ts').Expect<true>;",
          // Another package that happens to share the old name.
          "import { render } from 'verso';",
          'const text = "import { x } from \'verso\'";',
        ),
      ).toEqual([]);
    });

    it('nor type-only imports that follow an export without `from`', () => {
      expect(
        problems(
          'export enum Color { Red, Green }',
          "import type { Equal } from 'verso-ts';",
          'export class A {}',
          "import type { Expect } from 'verso-ts';",
          'export {}',
          "import type { Extends } from 'verso-ts';",
          'export default A',
          "export type { GuardOf } from 'verso-ts';",
        ),
      ).toEqual([]);
    });
  });

  describe('reports `@ts-nocheck`, which leaves the blocks unchecked', () => {
    const block = ['// @verso x', 'declare type _x = [Expect<true>];'];

    it('when it is the last check pragma before the first statement', () => {
      expect(problems('// @ts-nocheck', ...block)).toEqual([nocheck(1)]);
      expect(problems('// @ts-check', '// @ts-nocheck', ...block)).toEqual([nocheck(2)]);
      expect(problems('// @ts-nocheck', '/// @ts-check', ...block)).toEqual([]);
    });

    it('but not later in the file, in a block comment, or in a file without blocks', () => {
      expect(problems('const a = 1;', '// @ts-nocheck', ...block)).toEqual([]);
      expect(problems('/* @ts-nocheck */', ...block)).toEqual([]);
      expect(problems('// @ts-nocheck', 'const a = 1;')).toEqual([]);
    });
  });

  it('reads blocks after JSX text when the source is TSX', () => {
    const source = lines(
      'export function Upload() {',
      '  return <p>Accepts image/*, video/mp4</p>;',
      '}',
      '',
      '// @verso Upload',
      'declare type _Upload = [Expect<Equal<Parameters<typeof Upload>, []>>];',
    );
    expect(parseBlocks(source, { jsx: true }).blocks).toEqual([{ name: 'Upload', line: 5, endLine: 6, assertions: 1 }]);
    expect(parseBlocks(source).blocks).toEqual([]);
  });

  it('does not take similar comments for markers', () => {
    const source = lines('// @versoX', '// see @verso', '/// @verso x', 'const a = 1;');
    expect(parseBlocks(source)).toEqual({ blocks: [], problems: [] });
  });
});
