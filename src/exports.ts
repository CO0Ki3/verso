// Finds what a file exports that type tests are for, so that agents and the Claude Code plugin can point at exports no
// block mentions yet: functions, whose signatures are the usual subject of a type test, and generic type aliases,
// which compute types. Re-exports, constants, classes, interfaces and plain type aliases are left out.

import { isPunct, isWord, lineAt, lineStarts, tokenize, type Token, type TokenizeOptions } from './tokens.ts';

export interface Exported {
  name: string;
  /** 1-based line of the `export` keyword. */
  line: number;
  kind: 'function' | 'type';
}

/** The top-level exported functions and generic type aliases of `source`, each once, in source order. */
export function findExports(source: string, options: TokenizeOptions = {}): Exported[] {
  const code = tokenize(source, options).filter((token) => token.kind !== 'comment');
  const starts = lineStarts(source);
  const found = new Map<string, Exported>();
  let depth = 0;
  for (let index = 0; index < code.length; index++) {
    const token = code[index]!;
    if (isPunct(token, '{')) depth++;
    else if (isPunct(token, '}')) depth--;
    if (depth !== 0 || !isWord(token, 'export')) continue;
    const definition = definitionAt(code, index + 1);
    // Overloads export the same name several times; the first one stands for all.
    if (definition !== undefined && !found.has(definition.name)) {
      found.set(definition.name, { ...definition, line: lineAt(starts, token.start) });
    }
  }
  return [...found.values()];
}

/** Whether `text`, the source of a block, mentions `name` as a whole word, as `typeof name` or `Name<...>` do. */
export function mentions(text: string, name: string): boolean {
  const escaped = name.replace(/[$]/g, '\\$&');
  return new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`).test(text);
}

/** The function or generic type alias that the declaration starting at `index`, right after `export`, defines. */
function definitionAt(code: readonly Token[], index: number): Omit<Exported, 'line'> | undefined {
  let at = index;
  if (isWord(code[at], 'default') || isWord(code[at], 'declare')) at++;
  if (isWord(code[at], 'async')) at++;
  if (isWord(code[at], 'function')) {
    at++;
    if (isPunct(code[at], '*')) at++;
    const name = code[at];
    return name?.kind === 'word' ? { name: name.text, kind: 'function' } : undefined;
  }
  if (isWord(code[at], 'type')) {
    const name = code[at + 1];
    return name?.kind === 'word' && isPunct(code[at + 2], '<') ? { name: name.text, kind: 'type' } : undefined;
  }
  if (isWord(code[at], 'const') || isWord(code[at], 'let') || isWord(code[at], 'var')) {
    const name = code[at + 1];
    if (name?.kind !== 'word') return undefined;
    const value = valueAt(code, at + 2);
    return value !== undefined && isFunction(code, value) ? { name: name.text, kind: 'function' } : undefined;
  }
  return undefined;
}

/** Index of the first token of a variable's value, skipping a type annotation; `undefined` without a value. */
function valueAt(code: readonly Token[], index: number): number | undefined {
  let depth = 0;
  for (let at = index; at < code.length; at++) {
    const token = code[at]!;
    if (token.kind !== 'punct') continue;
    if (token.text === '(' || token.text === '[' || token.text === '{') depth++;
    else if (token.text === ')' || token.text === ']' || token.text === '}') depth--;
    else if (depth === 0 && token.text === ';') return undefined;
    // `=>` in a function type arrives as `=` and `>`.
    else if (depth === 0 && token.text === '=' && !isPunct(code[at + 1], '>')) return at + 1;
  }
  return undefined;
}

/** Whether the value starting at `index` is a function expression or an arrow function. */
function isFunction(code: readonly Token[], index: number): boolean {
  const first = code[index];
  if (isWord(first, 'function') || isWord(first, 'async') || isPunct(first, '<')) return true;
  if (first?.kind === 'word') return isPunct(code[index + 1], '=') && isPunct(code[index + 2], '>');
  if (!isPunct(first, '(')) return false;
  let depth = 0;
  for (let at = index; at < code.length; at++) {
    if (isPunct(code[at], '(')) depth++;
    else if (isPunct(code[at], ')') && --depth === 0) {
      const next = code[at + 1];
      // `(...) =>`, or `(...): ReturnType =>`.
      return (isPunct(next, '=') && isPunct(code[at + 2], '>')) || isPunct(next, ':');
    }
  }
  return false;
}
