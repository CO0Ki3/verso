// Assigns diagnostics to the blocks whose lines they fall on. A block with any diagnostic fails; the rest are
// type errors outside blocks.

import type { Block, Problem } from './blocks.ts';
import type { Diagnostic } from './diagnostics.ts';

export interface SourceFile {
  /** Absolute path, normalized the same way as the diagnostic paths. */
  path: string;
  blocks: Block[];
  problems: Problem[];
}

export interface BlockResult {
  file: string;
  block: Block;
  diagnostics: Diagnostic[];
}

export interface Assignment {
  /** One result per block, in file order and then line order. */
  results: BlockResult[];
  /** Diagnostics that fall on no block, in the order tsc printed them. */
  outside: Diagnostic[];
}

export function assign(files: readonly SourceFile[], diagnostics: readonly Diagnostic[]): Assignment {
  const results: BlockResult[] = [];
  const byFile = new Map<string, BlockResult[]>();
  for (const file of files) {
    const fileResults = file.blocks.map((block) => ({ file: file.path, block, diagnostics: [] as Diagnostic[] }));
    results.push(...fileResults);
    byFile.set(file.path, fileResults);
  }

  const outside: Diagnostic[] = [];
  for (const diagnostic of diagnostics) {
    const { file, line } = diagnostic;
    const owner =
      file === undefined || line === undefined
        ? undefined
        : byFile.get(file)?.find(({ block }) => block.line <= line && line <= block.endLine);
    if (owner === undefined) outside.push(diagnostic);
    else owner.diagnostics.push(diagnostic);
  }
  return { results, outside };
}
