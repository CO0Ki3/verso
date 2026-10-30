// Runs the CLI against fixture projects written to a temporary directory. The fixtures hold deliberate type errors,
// so they are created at run time instead of living in the repository, where they would break its own type check.

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import { envFile, helperFile } from '../src/init.ts';

const CLI = join(import.meta.dirname, '../src/cli.ts');

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: 'es2022',
    lib: ['es2022'],
    module: 'nodenext',
    types: [],
    strict: true,
    noUnusedLocals: true,
    allowImportingTsExtensions: true,
    noEmit: true,
  },
  include: ['src'],
});

/** A guard with its helper import on line 1, so the block written after it starts on line 7. */
const isDateWith = (imports: string): string => `import type { ${imports} } from './verso.ts';

export function isDate(value: unknown): value is Date {
  return value instanceof Date;
}
`;
const IS_DATE = isDateWith('Equal, Expect, GuardOf');

const IS_DATE_BLOCK = `${IS_DATE}
// @verso isDate
declare type _isDate = [Expect<Equal<GuardOf<typeof isDate>, Date>>];
`;

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/**
 * Writes files into a new temporary directory and returns its path. A project gets a tsconfig and the two files
 * `verso init --standalone` would write, with the key 'fixture', unless `files` gives them; `null` leaves one out.
 */
function project(files: Record<string, string | null>, defaults = true): string {
  const root = mkdtempSync(join(tmpdir(), 'verso-'));
  roots.push(root);
  const all = defaults
    ? {
        'tsconfig.json': TSCONFIG,
        'src/verso.ts': helperFile('fixture', true),
        'src/verso.env.d.ts': envFile('fixture'),
        ...files,
      }
    : files;
  write(root, all);
  return root;
}

function write(root: string, files: Record<string, string | null>): void {
  for (const [path, content] of Object.entries(files)) {
    if (content === null) continue;
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

function verso(cwd: string, ...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const child = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    // A shell passes the directory as it was typed in PWD, symlinks unresolved (macOS temp directories live under
    // /var, a symlink to /private/var). TypeScript 7, a Go program, takes its working directory from PWD.
    env: { ...process.env, NO_COLOR: '1', PWD: cwd },
  });
  return { status: child.status, stdout: child.stdout, stderr: child.stderr };
}

describe('verso', { timeout: 60_000 }, () => {
  it('passes when every block passes, even under noUnusedLocals', () => {
    const cwd = project({
      'src/isDate.ts': `${isDateWith('Equal, Expect, GuardOf, NotEqual')}
// @verso isDate
declare type _isDate = [
  Expect<Equal<Parameters<typeof isDate>, [unknown]>>,
  Expect<Equal<GuardOf<typeof isDate>, Date>>,
  Expect<NotEqual<GuardOf<typeof isDate>, string>>,
];
`,
    });
    const result = verso(cwd);
    expect(result.stdout).toBe('1 block: 1 passed, 0 failed · 3 assertions\n');
    expect(result.status).toBe(0);
  });

  it('names a failing block and shows the actual and expected types', () => {
    const cwd = project({
      'src/isDate.ts': `${isDateWith('Equal, Expect, GuardOf, NotEqual')}
// @verso isDate
declare type _isDate = [
  Expect<Equal<GuardOf<typeof isDate>, Date>>,
  Expect<Equal<GuardOf<typeof isDate>, string>>,
  Expect<NotEqual<GuardOf<typeof isDate>, Date>>,
  // @ts-expect-error 'a' is a key, so nothing fails here and the directive is unused
  Pick<{ a: 1 }, 'a'>,
];

// @verso still fine
declare type _fine = [Expect<Equal<ReturnType<typeof isDate>, boolean>>];
`,
    });
    const result = verso(cwd);
    expect(result.stdout).toBe(
      [
        '✗ src/isDate.ts:7  isDate',
        "    10:10  TS2344  Type '{ actual: Date; expected: string; }' does not satisfy the constraint 'true'.",
        "    11:10  TS2344  Type '{ actual: Date; expectedNotEqual: Date; }' does not satisfy the constraint 'true'.",
        "    12:3  TS2578  Unused '@ts-expect-error' directive.",
        '',
        '2 blocks: 1 passed, 1 failed · 4 assertions',
        '',
      ].join('\n'),
    );
    expect(result.status).toBe(1);
  });

  it('compares an enum with the union of its members as equal', () => {
    const cwd = project({
      'src/color.ts': `import type { Equal, Expect, NotEqual } from './verso.ts';

export enum Color {
  Red,
  Green,
}

export function toColor(warm: boolean) {
  return warm ? Color.Red : Color.Green;
}

// @verso toColor
declare type _toColor = [
  Expect<Equal<ReturnType<typeof toColor>, Color>>,
  Expect<NotEqual<Color, 0 | 1>>,
];
`,
    });
    const result = verso(cwd);
    expect(result.stdout).toBe('1 block: 1 passed, 0 failed · 2 assertions\n');
    expect(result.status).toBe(0);
  });

  it('checks blocks even when the tsconfig turns the checker off', () => {
    const cwd = project({
      'tsconfig.json': TSCONFIG.replace('"noEmit":true', '"noEmit":true,"noCheck":true'),
      'src/isDate.ts': IS_DATE_BLOCK.replace('Date>>]', 'string>>]'),
    });
    const result = verso(cwd);
    expect(result.stdout).toContain('✗ src/isDate.ts:7  isDate');
    expect(result.status).toBe(1);
  });

  it('finds blocks after JSX text in TSX files', () => {
    const cwd = project({
      'tsconfig.json': TSCONFIG.replace('"noEmit":true', '"noEmit":true,"jsx":"preserve"'),
      'src/jsx.d.ts':
        'declare namespace JSX {\n  interface IntrinsicElements {\n    [name: string]: unknown;\n  }\n}\n',
      'src/Upload.tsx': `import type { Equal, Expect } from './verso.ts';

export function Upload() {
  return <p>Accepts image/*, video/mp4. Press \` to open the console.</p>;
}

// @verso Upload
declare type _Upload = [Expect<Equal<Parameters<typeof Upload>, [string]>>];
`,
    });
    const result = verso(cwd);
    expect(result.stdout).toContain('✗ src/Upload.tsx:7  Upload');
    expect(result.stdout).toMatch(/1 block: 0 passed, 1 failed · 1 assertion\n$/);
    expect(result.status).toBe(1);
  });

  it('counts a file once when tsc reaches it through a symlink as well', () => {
    const block = IS_DATE_BLOCK.replace('./verso.ts', '../verso.ts').replace('Date>>]', 'string>>]');
    const cwd = project({ 'src/real/isDate.ts': block, 'src/link/.keep': '' });
    // At the same depth, so that the relative import resolves the same way through both paths.
    symlinkSync('../real/isDate.ts', join(cwd, 'src/link/isDate.ts'));
    const result = verso(cwd);
    expect(result.stdout).toBe(
      [
        '✗ src/real/isDate.ts:7  isDate',
        "    8:32  TS2344  Type '{ actual: Date; expected: string; }' does not satisfy the constraint 'true'.",
        '',
        '1 block: 0 passed, 1 failed · 1 assertion',
        '',
      ].join('\n'),
    );
    expect(result.status).toBe(1);
  });

  it('catches an empty array literal compared with an array type', () => {
    const cwd = project({
      'src/empty.ts': `import type { Equal, Expect, NotEqual } from './verso.ts';

export function empty() {
  return [];
}

// @verso empty
declare type _empty = [
  Expect<NotEqual<ReturnType<typeof empty>, string[]>>,
  Expect<Equal<ReturnType<typeof empty>, never[]>>,
];
`,
    });
    const result = verso(cwd);
    expect(result.stdout).toBe('1 block: 1 passed, 0 failed · 2 assertions\n');
    expect(result.status).toBe(0);
  });

  it('fails on type errors outside blocks', () => {
    const cwd = project({
      'src/isDate.ts': `${IS_DATE}
declare const nested: { a: { b: number } };
export const wrong: { a: { b: string } } = nested;

// @verso isDate
declare type _isDate = [Expect<Equal<GuardOf<typeof isDate>, Date>>];
`,
    });
    const result = verso(cwd);
    expect(result.stdout).toBe(
      [
        'Errors outside blocks: 1',
        "    src/isDate.ts:8:14  TS2322  Type '{ a: { b: number; }; }' is not assignable to type '{ a: { b: string; }; }'.",
        "                                The types of 'a.b' are incompatible between these types.",
        "                                  Type 'number' is not assignable to type 'string'.",
        '',
        '1 block: 1 passed, 0 failed · 1 assertion · 1 outside blocks',
        '',
      ].join('\n'),
    );
    expect(result.status).toBe(1);
  });

  it('does not count blocks as passed when tsc stops before type checking', () => {
    const cwd = project({
      'src/isDate.ts': `${IS_DATE}
export const broken = ;

// @verso isDate
declare type _isDate = [Expect<Equal<GuardOf<typeof isDate>, string>>];
`,
    });
    const result = verso(cwd, '--verbose');
    expect(result.stdout).toContain('? src/isDate.ts:9  isDate  not checked');
    expect(result.stdout).toContain('tsc stopped before type checking');
    expect(result.stdout).toMatch(/1 block: 0 passed, 0 failed, 1 not checked · 1 assertion · 1 outside blocks\n$/);
    expect(result.status).toBe(1);
  });

  describe('reports problems', () => {
    it('malformed blocks', () => {
      const cwd = project({
        'src/isDate.ts': `${IS_DATE}
// @verso isDate
export declare type _isDate = [Expect<Equal<GuardOf<typeof isDate>, Date>>];
`,
      });
      const result = verso(cwd);
      expect(result.stdout).toContain(
        'Problems: 1\n    src/isDate.ts:7  a block must not be exported, or it would leak into declaration output',
      );
      expect(result.status).toBe(1);
    });

    it('a missing verso.env.d.ts, which leaves every assertion unchecked', () => {
      const cwd = project({
        'src/verso.env.d.ts': null,
        'src/isDate.ts': `${IS_DATE}
// @verso isDate
declare type _isDate = [Expect<Equal<GuardOf<typeof isDate>, string>>];
`,
      });
      const result = verso(cwd);
      expect(result.stdout).toBe(
        [
          'Problems: 1',
          '    no verso.env.d.ts in the program, so `Expect` accepts anything and no block checks anything; run ' +
            '`verso init` and make sure the tsconfig includes the file',
          '',
          '1 block: 1 passed, 0 failed · 1 assertion · 1 problem',
          '',
        ].join('\n'),
      );
      expect(result.status).toBe(1);
    });

    it('a key that verso.env.d.ts does not enable', () => {
      const cwd = project({ 'src/verso.env.d.ts': envFile('another'), 'src/isDate.ts': IS_DATE_BLOCK });
      const helperLine =
        helperFile('fixture', true).split('\n').indexOf("export type Expect<T extends Gate<'fixture'>> = T;") + 1;
      const result = verso(cwd);
      expect(result.stdout).toContain(
        `    src/verso.ts:${helperLine}  this \`Expect\` depends on the key 'fixture', which no verso.env.d.ts in the program enables, so the blocks using it check nothing`,
      );
      expect(result.status).toBe(1);
    });

    it('`@ts-expect-error` negatives, which break in consumers', () => {
      const cwd = project({
        'src/isDate.ts': `${IS_DATE}
// @verso isDate
declare type _isDate = [
  // @ts-expect-error not a string guard
  Expect<Equal<GuardOf<typeof isDate>, string>>,
];
`,
      });
      const result = verso(cwd);
      expect(result.stdout).toContain(
        'Problems: 1\n    src/isDate.ts:9  a `@ts-expect-error` negative breaks in consumers, where the gate turns ' +
          '`Expect` off; write `Expect<NotEqual<...>>` or `Expect<NotExtends<...>>` instead',
      );
      expect(result.status).toBe(1);
    });

    it('a verso.env.d.ts that became a module, whose key no longer reaches the gate', () => {
      const cwd = project({
        'src/verso.env.d.ts': `export {};\n${envFile('fixture')}`,
        'src/isDate.ts': IS_DATE_BLOCK.replace('Date>>]', 'string>>]'),
      });
      const result = verso(cwd);
      expect(result.stdout).toContain("depends on the key 'fixture', which no verso.env.d.ts in the program enables");
      expect(result.status).toBe(1);
    });

    it('`@ts-nocheck` in a file with blocks', () => {
      const cwd = project({ 'src/isDate.ts': `// @ts-nocheck\n${IS_DATE_BLOCK}` });
      const result = verso(cwd);
      expect(result.stdout).toContain(
        'Problems: 1\n    src/isDate.ts:1  `@ts-nocheck` makes tsc skip this file, so its blocks check nothing',
      );
      expect(result.status).toBe(1);
    });

    it('helper imports that would survive in JS output', () => {
      const cwd = project({
        'node_modules/verso/package.json': JSON.stringify({ name: 'verso', types: './index.ts' }),
        'node_modules/verso/index.ts': helperFile('fixture', true),
        'src/isDate.ts': `import { type Equal, type Expect, type GuardOf } from 'verso';
${IS_DATE.split('\n').slice(1).join('\n')}
// @verso isDate
declare type _isDate = [Expect<Equal<GuardOf<typeof isDate>, Date>>];
`,
      });
      const result = verso(cwd);
      expect(result.stdout).toContain(
        "Problems: 1\n    src/isDate.ts:1  use `import type` for 'verso': under `verbatimModuleSyntax` any other form stays in the JS output",
      );
      expect(result.status).toBe(1);
    });
  });

  it('keeps the gate shut for a consumer that compiles the source under other options', () => {
    // The library checks `noUncheckedIndexedAccess`; the consumer does not use it and never sees verso.env.d.ts.
    const root = project(
      {
        'lib/tsconfig.json': TSCONFIG.replace('"strict":true', '"strict":true,"noUncheckedIndexedAccess":true'),
        'lib/src/verso.ts': helperFile('lib', true),
        'lib/src/verso.env.d.ts': envFile('lib'),
        'lib/src/first.ts': `import type { Equal, Expect } from './verso.ts';

export function first(values: readonly string[]) {
  return values[0];
}

// @verso first
declare type _first = [Expect<Equal<ReturnType<typeof first>, string | undefined>>];
`,
        'app/tsconfig.json': TSCONFIG,
        'app/src/main.ts': `import { first } from '../../lib/src/first.ts';

export const head: string | undefined = first(['a']);
`,
      },
      false,
    );
    const lib = verso(join(root, 'lib'));
    expect(lib.stdout).toBe('1 block: 1 passed, 0 failed · 1 assertion\n');
    expect(lib.status).toBe(0);
    const app = spawnSync(process.execPath, [tscPath(), '-p', 'tsconfig.json', '--pretty', 'false'], {
      cwd: join(root, 'app'),
      encoding: 'utf8',
      env: { ...process.env, PWD: join(root, 'app') },
    });
    expect(app.stdout).toBe('');
    expect(app.status).toBe(0);
  });

  it('keeps the gate open under moduleDetection force', () => {
    const cwd = project({
      'tsconfig.json': TSCONFIG.replace('"strict":true', '"strict":true,"moduleDetection":"force"'),
      'src/isDate.ts': `${IS_DATE}
// @verso isDate
declare type _isDate = [Expect<Equal<GuardOf<typeof isDate>, string>>];
`,
    });
    const result = verso(cwd);
    expect(result.stdout).toContain('✗ src/isDate.ts:7  isDate');
    expect(result.status).toBe(1);
  });

  it('leaves no tsbuildinfo behind in incremental projects', () => {
    const cwd = project({
      'tsconfig.json': TSCONFIG.replace('"noEmit":true', '"noEmit":true,"incremental":true,"composite":true'),
      'src/isDate.ts': IS_DATE_BLOCK,
    });
    const result = verso(cwd);
    expect(result.status).toBe(0);
    expect(readdirSync(cwd).toSorted()).toEqual(['src', 'tsconfig.json']);
  });

  it('fails when there is no block at all', () => {
    const result = verso(project({ 'src/isDate.ts': IS_DATE }));
    expect(result.stdout).toContain('No verso blocks found in 2 source files.');
    expect(result.status).toBe(1);
  });

  it('explains an empty solution-style tsconfig', () => {
    const cwd = project({ 'tsconfig.json': JSON.stringify({ files: [], references: [{ path: './app' }] }) });
    const result = verso(cwd);
    expect(result.stdout).toContain('tsc listed no files');
    expect(result.status).toBe(1);
  });

  it('scans only the project itself, not sources it imports from elsewhere', () => {
    const root = project(
      {
        'shared/one.ts': `import type { Equal, Expect } from '../app/src/verso.ts';

export const one = 1;

// @verso shared
declare type _shared = [Expect<Equal<typeof one, 2>>];
`,
        'app/tsconfig.json': TSCONFIG,
        'app/src/verso.ts': helperFile('app', true),
        'app/src/verso.env.d.ts': envFile('app'),
        'app/src/main.ts': `import type { Equal, Expect } from './verso.ts';
import { one } from '../../shared/one.ts';

// @verso main
declare type _main = [Expect<Equal<typeof one, 1>>];
`,
      },
      false,
    );
    const result = verso(join(root, 'app'));
    expect(result.stdout).toBe(
      [
        'Errors outside blocks: 1',
        "    ../shared/one.ts:6:32  TS2344  Type '{ actual: 1; expected: 2; }' does not satisfy the constraint 'true'.",
        '',
        '1 block: 1 passed, 0 failed · 1 assertion · 1 outside blocks',
        '',
      ].join('\n'),
    );
    expect(result.status).toBe(1);
  });

  it('accepts a tsconfig path or a directory with -p, and lists passing blocks with --verbose', () => {
    const root = project(
      {
        'tsconfig.json': '{ "files": [] }',
        'pkg/tsconfig.json': TSCONFIG,
        'pkg/src/verso.ts': helperFile('pkg', true),
        'pkg/src/verso.env.d.ts': envFile('pkg'),
        'pkg/src/isDate.ts': IS_DATE_BLOCK,
      },
      false,
    );
    const byFile = verso(root, '-p', 'pkg/tsconfig.json', '--verbose');
    expect(byFile.stdout).toMatch(
      /^TypeScript \d+\.\d+\.\d+ \(.+\)\n\n✓ pkg\/src\/isDate\.ts:7  isDate  1 assertion\n\n/,
    );
    expect(byFile.status).toBe(0);
    expect(verso(root, '--project', 'pkg').status).toBe(0);
  });

  it("uses the project's own TypeScript", () => {
    const realTsc = pathToFileURL(join(dirname(tscPath()), '../lib/tsc.js')).href;
    const cwd = project({
      'node_modules/typescript/package.json': JSON.stringify({
        name: 'typescript',
        version: '7.0.0-local',
        type: 'module',
        bin: { tsc: './bin/tsc.js' },
      }),
      'node_modules/typescript/bin/tsc.js': `import ${JSON.stringify(realTsc)};\n`,
      'src/isDate.ts': IS_DATE_BLOCK,
    });
    const result = verso(cwd, '--verbose');
    expect(result.stdout.split('\n')[0]).toBe('TypeScript 7.0.0-local (node_modules/typescript/bin/tsc.js)');
    expect(result.status).toBe(0);
  });

  it('exits with 2 when it cannot run', () => {
    const cwd = project({});
    const missing = verso(cwd, '-p', 'nope.json');
    expect(missing.stderr).toBe('verso: cannot find nope.json\n');
    expect(missing.status).toBe(2);
    const unknown = verso(cwd, '--nope');
    expect(unknown.stderr).toMatch(/^verso: Unknown option '--nope'/);
    expect(unknown.status).toBe(2);
    const command = verso(cwd, 'nope');
    expect(command.stderr).toMatch(/^verso: unknown command 'nope'/);
    expect(command.status).toBe(2);
  });

  it('prints usage with --help', () => {
    const result = verso(project({}), '--help');
    expect(result.stdout).toMatch(/^Usage: verso \[-p <tsconfig>\] \[--verbose\]/);
    expect(result.status).toBe(0);
  });
});

describe('verso init', { timeout: 60_000 }, () => {
  it('writes a helper importing from verso, and verso.env.d.ts keyed by the package name', () => {
    const cwd = project({ 'package.json': JSON.stringify({ name: '@scope/lib' }) }, false);
    const result = verso(cwd, 'init');
    expect(result.stdout).toBe(
      'wrote src/verso.ts\nwrote src/verso.env.d.ts\n' +
        'Make sure the tsconfig includes src/verso.env.d.ts, and that nothing imports it.\n',
    );
    expect(readFileSync(join(cwd, 'src/verso.ts'), 'utf8')).toBe(helperFile('@scope/lib', false));
    expect(readFileSync(join(cwd, 'src/verso.env.d.ts'), 'utf8')).toBe(envFile('@scope/lib'));

    // The helper resolves 'verso' like any package; here it is a copy of this repository's entry point.
    write(cwd, {
      'tsconfig.json': TSCONFIG,
      'node_modules/verso/package.json': JSON.stringify({ name: 'verso', types: './index.ts' }),
      'node_modules/verso/index.ts': readFileSync(join(import.meta.dirname, '../src/index.ts'), 'utf8'),
      'src/isDate.ts': IS_DATE_BLOCK,
    });
    expect(verso(cwd).stdout).toBe('1 block: 1 passed, 0 failed · 1 assertion\n');
    writeFileSync(join(cwd, 'src/isDate.ts'), IS_DATE_BLOCK.replace('Date>>]', 'string>>]'));
    expect(verso(cwd).stdout).toContain('✗ src/isDate.ts:7  isDate');
  });

  it('copies the helpers with --standalone and keeps existing files', () => {
    const cwd = project({ 'lib/verso.env.d.ts': 'interface VersoEnabled {}\n' }, false);
    const result = verso(cwd, 'init', '--standalone', '--dir', 'lib', '--key', 'k');
    expect(result.stdout).toBe(
      'wrote lib/verso.ts\nkept lib/verso.env.d.ts: it already exists\n' +
        'Make sure the tsconfig includes lib/verso.env.d.ts, and that nothing imports it.\n',
    );
    expect(readFileSync(join(cwd, 'lib/verso.ts'), 'utf8')).toBe(helperFile('k', true));
    expect(readFileSync(join(cwd, 'lib/verso.env.d.ts'), 'utf8')).toBe('interface VersoEnabled {}\n');
    expect(existsSync(join(cwd, 'src'))).toBe(false);
  });
});

function tscPath(): string {
  const manifest = createRequire(import.meta.filename).resolve('typescript/package.json');
  return join(dirname(manifest), 'bin/tsc');
}
