import { describe, expect, it } from 'vitest';

import { parseTscOutput, typeCheckRan, type Diagnostic } from '../src/diagnostics.ts';

const cwd = '/work/project';

describe('parseTscOutput', () => {
  it('reads located diagnostics and resolves their paths against the working directory', () => {
    const output = [
      "src/isDate.ts(11,10): error TS2344: Type '{ actual: Date; expected: string; }' does not satisfy the constraint 'true'.",
      "../shared/a.ts(3,1): error TS2322: Type 'number' is not assignable to type 'string'.",
    ].join('\n');
    expect(parseTscOutput(output, cwd).diagnostics).toEqual([
      {
        file: '/work/project/src/isDate.ts',
        line: 11,
        column: 10,
        code: 'TS2344',
        category: 'error',
        message: "Type '{ actual: Date; expected: string; }' does not satisfy the constraint 'true'.",
        details: [],
      },
      {
        file: '/work/shared/a.ts',
        line: 3,
        column: 1,
        code: 'TS2322',
        category: 'error',
        message: "Type 'number' is not assignable to type 'string'.",
        details: [],
      },
    ]);
  });

  it('attaches indented continuation lines to the diagnostic before them', () => {
    const output = [
      "src/a.ts(1,7): error TS2322: Type '{ a: { b: number; }; }' is not assignable to type '{ a: { b: string; }; }'.",
      "  The types of 'a.b' are incompatible between these types.",
      "    Type 'number' is not assignable to type 'string'.",
      'src/a.ts(2,1): error TS1005: Expected.',
    ].join('\n');
    const { diagnostics } = parseTscOutput(output, cwd);
    expect(diagnostics.map((diagnostic) => diagnostic.details)).toEqual([
      [
        "The types of 'a.b' are incompatible between these types.",
        "  Type 'number' is not assignable to type 'string'.",
      ],
      [],
    ]);
  });

  it('reads diagnostics without a location', () => {
    const output = "error TS5023: Unknown compiler option 'nope'.\r\nerror TS6053: File 'x.ts' not found.\r\n";
    expect(parseTscOutput(output, cwd).diagnostics).toEqual([
      { code: 'TS5023', category: 'error', message: "Unknown compiler option 'nope'.", details: [] },
      { code: 'TS6053', category: 'error', message: "File 'x.ts' not found.", details: [] },
    ]);
  });

  it('separates the listed files from the diagnostics', () => {
    const output = [
      'src/a.ts(1,1): error TS2304: Cannot find name x.',
      '/work/project/node_modules/typescript/lib/lib.es5.d.ts',
      '/work/project/src/a.ts',
      '',
    ].join('\n');
    const result = parseTscOutput(output, cwd);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.files).toEqual(['/work/project/node_modules/typescript/lib/lib.es5.d.ts', '/work/project/src/a.ts']);
    expect(result.unrecognized).toEqual([]);
  });

  it('reads paths that contain parentheses', () => {
    const output = "app/(group)/page.ts(3,5): error TS2322: Type 'number' is not assignable to type 'string'.";
    expect(parseTscOutput(output, cwd).diagnostics[0]).toMatchObject({
      file: '/work/project/app/(group)/page.ts',
      line: 3,
      column: 5,
    });
  });

  it('keeps lines it cannot read', () => {
    const output = ['Found 1 error.', '  stray indented line', 'src/a.ts(1,1): error TS2304: Cannot find name x.'].join(
      '\n',
    );
    const result = parseTscOutput(output, cwd);
    expect(result.unrecognized).toEqual(['Found 1 error.', '  stray indented line']);
    expect(result.diagnostics).toHaveLength(1);
  });
});

const at = (file: string | undefined, code: string): Diagnostic => ({
  ...(file === undefined ? {} : { file, line: 1, column: 1 }),
  code,
  category: 'error',
  message: 'message',
  details: [],
});

describe('typeCheckRan', () => {
  const program = new Set(['/p/a.ts', '/p/view.tsx', '/p/data.json']);
  const ran = (...diagnostics: Diagnostic[]): boolean => typeCheckRan(diagnostics, program);

  it('holds without diagnostics and with type errors', () => {
    expect(ran()).toBe(true);
    expect(ran(at('/p/a.ts', 'TS2344'), at('/p/a.ts', 'TS6133'))).toBe(true);
  });

  it('fails on syntax and compiler option errors, which stop tsc before type checking', () => {
    expect(ran(at('/p/a.ts', 'TS1005'))).toBe(false);
    expect(ran(at(undefined, 'TS5023'))).toBe(false);
    expect(ran(at('/p/tsconfig.json', 'TS5052'))).toBe(false);
    expect(ran(at(undefined, 'TS18003'))).toBe(false);
    expect(ran(at('/p/a.ts', 'TS6053'))).toBe(false);
  });

  it('fails on JSX syntax errors and TypeScript syntax in JS files', () => {
    expect(ran(at('/p/view.tsx', 'TS17002'))).toBe(false);
    expect(ran(at('/p/view.tsx', 'TS17008'), at('/p/view.tsx', 'TS1005'))).toBe(false);
    expect(ran(at('/p/a.js', 'TS8010'))).toBe(false);
  });

  it('tells a syntax error in a tsconfig, which tsc still checks after, from one in a JSON module', () => {
    expect(ran(at('/p/tsconfig.json', 'TS1005'))).toBe(true);
    expect(ran(at('/p/tsconfig.base.json', 'TS1005'), at('/p/a.ts', 'TS2344'))).toBe(true);
    expect(ran(at('/p/data.json', 'TS1005'))).toBe(false);
  });

  it('trusts a type error over a grammar error that only the checker reports', () => {
    expect(ran(at('/p/a.ts', 'TS1184'), at('/p/a.ts', 'TS2322'))).toBe(true);
  });
});
