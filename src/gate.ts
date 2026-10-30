// Reads the keys behind the gate. A package's `Expect` checks only in programs that enable the package's key, so a
// missing verso.env.d.ts, or a key it does not enable, quietly turns every assertion into a pass. The CLI reports
// both, using what these functions read.

import { isPunct, isWord, lineAt, lineStarts, tokenize, type Token } from './tokens.ts';

/**
 * The file that enables a package's key in the package's own program. Only `.d.ts`: a `.d.mts` or `.d.cts` file is
 * always a module, whose interfaces stay local to it.
 */
export const ENV_FILE: RegExp = /(?:^|[\\/])verso\.env\.d\.ts$/;

/**
 * Keys enabled by `interface VersoEnabled { ... }` declarations in `source` that merge with the global interface
 * `Gate` reads: those at the top level of a script, that is a file without a top-level `import` or `export`, and
 * those directly inside `declare global { ... }`. Any other one is local to its module or namespace and enables
 * nothing.
 */
export function enabledKeys(source: string): string[] {
  const tokens = code(source);
  const script = !isModule(tokens);
  const keys: string[] = [];
  // For each open brace, whether declarations directly inside it are global.
  const scopes: boolean[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (isPunct(token, '{')) {
      scopes.push(isWord(tokens[index - 1], 'global') && isWord(tokens[index - 2], 'declare'));
      continue;
    }
    if (isPunct(token, '}')) {
      scopes.pop();
      continue;
    }
    if (!isWord(token, 'interface') || !isWord(tokens[index + 1], 'VersoEnabled')) continue;
    const global = scopes.length === 0 ? script : scopes.at(-1) === true;
    // Read the interface body. This consumes its braces, so `scopes` stays balanced.
    index += 2;
    while (index < tokens.length && !isPunct(tokens[index], '{')) index++;
    let depth = 0;
    for (; index < tokens.length; index++) {
      const member = tokens[index]!;
      if (isPunct(member, '{')) {
        depth++;
      } else if (isPunct(member, '}')) {
        if (--depth === 0) break;
      } else if (global && depth === 1 && (member.kind === 'word' || member.kind === 'string')) {
        const colon = isPunct(tokens[index + 1], '?') ? index + 2 : index + 1;
        if (isPunct(tokens[colon], ':')) keys.push(member.kind === 'string' ? member.text.slice(1, -1) : member.text);
      }
    }
  }
  return keys;
}

/** Keys that `type Expect<T extends Gate<'key'>>` definitions in `source` depend on, with their 1-based lines. */
export function gatedKeys(source: string): { key: string; line: number }[] {
  const tokens = code(source);
  const starts = lineStarts(source);
  const keys: { key: string; line: number }[] = [];
  for (let index = 0; index + 8 < tokens.length; index++) {
    const [type, expect, open, parameter, extend, gate, gateOpen, key, gateClose] = tokens.slice(index, index + 9);
    if (
      isWord(type, 'type') &&
      isWord(expect, 'Expect') &&
      isPunct(open, '<') &&
      parameter?.kind === 'word' &&
      isWord(extend, 'extends') &&
      isWord(gate, 'Gate') &&
      isPunct(gateOpen, '<') &&
      key?.kind === 'string' &&
      isPunct(gateClose, '>')
    ) {
      keys.push({ key: key.text.slice(1, -1), line: lineAt(starts, expect!.start) });
    }
  }
  return keys;
}

/** Whether a top-level `import` or `export` makes the file a module. */
function isModule(tokens: readonly Token[]): boolean {
  let depth = 0;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (isPunct(token, '{')) depth++;
    else if (isPunct(token, '}')) depth--;
    else if (depth === 0 && isWord(token, 'export')) return true;
    else if (
      depth === 0 &&
      isWord(token, 'import') &&
      !isPunct(tokens[index + 1], '(') &&
      !isPunct(tokens[index + 1], '.')
    ) {
      return true;
    }
  }
  return false;
}

function code(source: string): Token[] {
  return tokenize(source).filter((token) => token.kind !== 'comment');
}
