import { describe, expect, it } from 'vitest';

import { assign, type SourceFile } from '../src/assign.ts';
import type { Diagnostic } from '../src/diagnostics.ts';

const diagnostic = (file: string | undefined, line: number | undefined, code = 'TS2344'): Diagnostic => ({
  ...(file === undefined ? {} : { file }),
  ...(line === undefined ? {} : { line, column: 1 }),
  code,
  category: 'error',
  message: 'message',
  details: [],
});

const files: SourceFile[] = [
  {
    path: '/p/a.ts',
    blocks: [
      { name: 'first', line: 5, endLine: 8, assertions: 2 },
      { name: 'second', line: 10, endLine: 10, assertions: 1 },
    ],
    problems: [],
  },
  { path: '/p/b.ts', blocks: [{ name: 'third', line: 1, endLine: 3, assertions: 1 }], problems: [] },
];

describe('assign', () => {
  it('gives each diagnostic to the block whose lines it falls on, bounds included', () => {
    const inFirst = [diagnostic('/p/a.ts', 5), diagnostic('/p/a.ts', 8)];
    const inSecond = diagnostic('/p/a.ts', 10, 'TS2578');
    const { results, outside } = assign(files, [...inFirst, inSecond]);
    expect(results.map((result) => [result.block.name, result.diagnostics])).toEqual([
      ['first', inFirst],
      ['second', [inSecond]],
      ['third', []],
    ]);
    expect(outside).toEqual([]);
  });

  it('keeps diagnostics between blocks, in other files or without a location outside', () => {
    const between = diagnostic('/p/a.ts', 9);
    const elsewhere = diagnostic('/p/c.ts', 1);
    const unlocated = diagnostic(undefined, undefined, 'TS5023');
    const { results, outside } = assign(files, [between, elsewhere, unlocated]);
    expect(results.every((result) => result.diagnostics.length === 0)).toBe(true);
    expect(outside).toEqual([between, elsewhere, unlocated]);
  });
});
