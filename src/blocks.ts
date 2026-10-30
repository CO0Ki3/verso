// Finds verso blocks in a source file. A block is a `// @verso <name>` line comment followed by a non-exported
// `declare type _alias = [ ... ];` whose tuple holds the assertions. It covers the lines from the marker to the end
// of the declaration, and tsc diagnostics on those lines belong to it.
//
// The declaration ends at the bracket that closes the tuple, so a trailing `;` is optional and code formatted
// without semicolons works too.
//
// The same pass reports what would keep blocks from checking anything (`// @ts-nocheck`) and imports of the helper
// package that would survive in JS output.

import {
  hasLineBreak,
  isPunct,
  isWord,
  lineAt,
  lineStarts,
  tokenize,
  type Token,
  type TokenizeOptions,
} from './tokens.ts';

export interface Block {
  name: string;
  /** 1-based line of the marker comment. */
  line: number;
  /** 1-based last line of the declaration, inclusive. */
  endLine: number;
  /** Number of `Expect<...>` assertions in the tuple. */
  assertions: number;
}

/** A marker whose block cannot be read, a file that tsc does not check, or a helper import that survives in JS. */
export interface Problem {
  /** 1-based line of the marker comment, pragma or import. */
  line: number;
  message: string;
}

export interface ParsedBlocks {
  blocks: Block[];
  problems: Problem[];
}

const MARKER = /^\/\/\s*@verso(?:\s+(.*))?$/;
const EXPECT_ERROR = /^\/[/*]\s*@ts-expect-error\b/;
// The pragmas tsc reads from the comments before the first statement; the last one wins.
const CHECK_PRAGMA = /^\/\/\/?\s*@ts-(no)?check(?=[\s:]|$)/i;
const SHAPE = 'the marker must be followed by `declare type _name = [ ... ];`';
const OPENERS: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
const HELPERS = 'verso-ts';

export function parseBlocks(source: string, options: TokenizeOptions = {}): ParsedBlocks {
  const tokens = tokenize(source, options);
  const starts = lineStarts(source);
  const blocks: Block[] = [];
  const problems: Problem[] = [];
  const names = new Map<string, number>();

  /** Index of the first token from `from` on that is not a comment, or `tokens.length`. */
  const skipComments = (from: number): number => {
    let index = from;
    while (tokens[index]?.kind === 'comment') index++;
    return index;
  };

  /** Reads the declaration after the marker at `markerIndex`; returns where it ends, or why it cannot be read. */
  const readDeclaration = (markerIndex: number): { end: number; assertions: number } | string => {
    let index = markerIndex + 1;
    for (; tokens[index]?.kind === 'comment'; index++) {
      if (markerName(tokens[index]) !== undefined) return 'the marker is not followed by a declaration';
    }
    const first = tokens[index];
    if (isWord(first, 'export')) {
      const exported = tokens[skipComments(index + 1)];
      if (isWord(exported, 'declare') || isWord(exported, 'type')) {
        return 'a block must not be exported, or it would leak into declaration output';
      }
      return SHAPE;
    }
    if (isWord(first, 'type')) {
      return 'use `declare type`: a plain type alias that is never used fails `noUnusedLocals` (TS6196)';
    }
    if (!isWord(first, 'declare')) return SHAPE;

    index = skipComments(index + 1);
    if (!isWord(tokens[index], 'type')) return SHAPE;
    index = skipComments(index + 1);
    const alias = tokens[index];
    if (alias?.kind !== 'word') return SHAPE;
    if (!alias.text.startsWith('_')) {
      return `the alias name must start with \`_\` so that unused-variable lint rules skip it: '${alias.text}'`;
    }
    index = skipComments(index + 1);
    if (isPunct(tokens[index], '<')) return 'the block alias must not take type parameters';
    if (!isPunct(tokens[index], '=')) return SHAPE;
    index = skipComments(index + 1);
    if (!isPunct(tokens[index], '[')) return 'the block body must be a tuple of assertions: `= [ ... ];`';

    const open: string[] = [];
    let assertions = 0;
    let close: number | undefined;
    for (; index < tokens.length; index++) {
      const token = tokens[index]!;
      if (token.kind === 'comment') {
        if (markerName(token) !== undefined) return 'a `// @verso` marker cannot appear inside a block';
        if (EXPECT_ERROR.test(token.text) && isWord(tokens[skipComments(index + 1)], 'Expect')) {
          problems.push({
            line: lineAt(starts, token.start),
            message:
              'a `@ts-expect-error` negative breaks in consumers, where the gate turns `Expect` off; ' +
              'write `Expect<NotEqual<...>>` or `Expect<NotExtends<...>>` instead',
          });
        }
        continue;
      }
      if (isWord(token, 'Expect') && isPunct(tokens[skipComments(index + 1)], '<')) assertions++;
      if (token.kind !== 'punct') continue;
      if (token.text === '(' || token.text === '[' || token.text === '{') {
        open.push(token.text);
      } else if (token.text in OPENERS) {
        if (open.pop() !== OPENERS[token.text]) return 'the block has unbalanced brackets';
        if (open.length === 0) {
          close = index;
          break;
        }
      }
    }
    if (close === undefined) return 'the block tuple is never closed';
    if (assertions === 0) return 'the block has no `Expect<...>` assertion';

    const closing = tokens[close]!;
    const after = tokens[skipComments(close + 1)];
    if (isPunct(after, ';')) return { end: after!.start, assertions };
    // Without a `;`, the declaration still ends at the tuple if what follows starts a new statement. Only `|` and
    // `&` continue a type across a line break.
    const startsNewStatement =
      after === undefined ||
      (hasLineBreak(source, closing.end, after.start) && !isPunct(after, '|') && !isPunct(after, '&'));
    if (startsNewStatement) return { end: closing.start, assertions };
    return 'the block body must be a single tuple: end it with `;` right after `]`';
  };

  for (let index = 0; index < tokens.length; index++) {
    const marker = tokens[index]!;
    const name = markerName(marker);
    if (name === undefined) continue;
    const line = lineAt(starts, marker.start);
    const fail = (message: string): void => {
      problems.push({ line, message });
    };

    if (!startsLine(source, marker.start)) {
      fail('the `// @verso` marker must be on a line of its own');
      continue;
    }
    if (name === '') {
      fail('the marker needs a block name: `// @verso <name>`');
      continue;
    }
    const declaration = readDeclaration(index);
    if (typeof declaration === 'string') {
      fail(declaration);
      continue;
    }
    const firstLine = names.get(name);
    if (firstLine !== undefined) {
      fail(`the block name '${name}' is already used on line ${firstLine}`);
      continue;
    }
    names.set(name, line);
    blocks.push({ name, line, endLine: lineAt(starts, declaration.end), assertions: declaration.assertions });
  }

  if (blocks.length > 0) {
    let pragma: Token | undefined;
    for (const token of tokens) {
      if (token.kind !== 'comment') break;
      if (CHECK_PRAGMA.test(token.text)) pragma = token;
    }
    if (pragma !== undefined && /@ts-nocheck/i.test(pragma.text)) {
      problems.push({
        line: lineAt(starts, pragma.start),
        message: '`@ts-nocheck` makes tsc skip this file, so its blocks check nothing',
      });
    }
  }

  // Under `verbatimModuleSyntax`, only a whole-statement `import type` or `export type` is erased. Anything else
  // leaves `import 'verso-ts'` in the JS output, which fails at runtime wherever verso-ts is not installed.
  for (let index = 0; index < tokens.length; index++) {
    const keyword = tokens[index]!;
    if (!isWord(keyword, 'import') && !isWord(keyword, 'export')) continue;
    if (runtimeSpecifier(tokens, index) !== HELPERS) continue;
    problems.push({
      line: lineAt(starts, keyword.start),
      message: `use \`${keyword.text} type\` for '${HELPERS}': under \`verbatimModuleSyntax\` any other form stays in the JS output`,
    });
  }
  return { blocks, problems };
}

/**
 * The module specifier of the import or re-export declaration that starts at `start`, or `undefined` when there is
 * none or the whole declaration is type-only.
 */
function runtimeSpecifier(tokens: readonly Token[], start: number): string | undefined {
  const next = (from: number): number => {
    let index = from;
    while (tokens[index]?.kind === 'comment') index++;
    return index;
  };
  let index = next(start + 1);
  const first = tokens[index];
  if (isWord(first, 'type')) return undefined;
  if (isWord(tokens[start], 'import')) {
    if (first?.kind === 'string') return first.text.slice(1, -1);
  } else if (!isPunct(first, '{') && !isPunct(first, '*')) {
    // Only `export { ... } from` and `export * from` re-export; `export const`, `export class` and the like do not.
    return undefined;
  }
  for (; index < tokens.length; index = next(index + 1)) {
    const token = tokens[index]!;
    if (isWord(token, 'from')) {
      const specifier = tokens[next(index + 1)];
      if (specifier?.kind === 'string') return specifier.text.slice(1, -1);
    }
    // An import or export clause holds only names, string names, braces, commas and `*`. Another `import` or
    // `export` means the declaration ended without `from`, as `export {}` does.
    const inClause =
      (token.kind === 'word' && token.text !== 'import' && token.text !== 'export') ||
      token.kind === 'string' ||
      (token.kind === 'punct' && '{},*'.includes(token.text));
    if (!inClause) return undefined;
  }
  return undefined;
}

/** The block name of a marker comment (empty when missing), or `undefined` when the token is not a marker. */
function markerName(token: Token | undefined): string | undefined {
  if (token?.kind !== 'comment') return undefined;
  const match = MARKER.exec(token.text);
  return match === null ? undefined : (match[1] ?? '').trim();
}

function startsLine(source: string, offset: number): boolean {
  for (let i = offset - 1; i >= 0; i--) {
    const char = source.charAt(i);
    if (char === '\n' || char === '\r' || char === '\u2028' || char === '\u2029') return true;
    if (!/\s/.test(char)) return false;
  }
  return true;
}
