// `verso init`: writes the two files a package needs. The helper file defines the package's `Expect`, gated by the
// package's key, and re-exports the other helpers. verso.env.d.ts enables the key in the package's own program.
// Nothing imports the env file, so a consumer compiling the package's source never sees it and the gate stays shut.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const EXPECT = (key: string): string => `/**
 * Accepts only \`true\` in this package's own program, which includes verso.env.d.ts. Anywhere else, such as in a
 * consumer that compiles this package's source, it accepts anything, so the consumer's compiler options cannot fail
 * the blocks.
 */
export type Expect<T extends Gate<${quote(key)}>> = T;
`;

/**
 * The helper file that blocks import. By default it imports the helpers from 'verso'; `standalone` copies their
 * definitions instead, for packages whose sources may import relative paths only.
 */
export function helperFile(key: string, standalone: boolean): string {
  if (standalone) {
    const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    const end = source.indexOf('\n// End of the helpers.');
    if (end < 0) throw new Error('verso: cannot find the end of the helpers in src/index.ts');
    return `${source.slice(0, end + 1)}\n${EXPECT(key)}`;
  }
  return `// In-source type test helpers for this package, made by \`verso init\`. Blocks import them from here.
import type { Gate } from 'verso';

export type { Equal, Extends, GuardOf, NotEqual, NotExtends } from 'verso';

${EXPECT(key)}`;
}

export function envFile(key: string): string {
  return `// Enables this package's verso blocks in its own program, made by \`verso init\`. Nothing may import this file:
// a program that compiles the package's source without it, such as a consumer's, must not have the key. It declares
// no import or export, so the interface below is global and merges with the one the helpers declare.
interface VersoEnabled {
  ${quote(key)}: true;
}
`;
}

/** Writes both files into `dir` unless they exist; returns one line per file saying what happened. */
export function init(dir: string, key: string, standalone: boolean): string[] {
  mkdirSync(dir, { recursive: true });
  const files: [string, string][] = [
    ['verso.ts', helperFile(key, standalone)],
    ['verso.env.d.ts', envFile(key)],
  ];
  return files.map(([name, content]) => {
    const path = join(dir, name);
    if (existsSync(path)) return `kept ${path}: it already exists`;
    writeFileSync(path, content);
    return `wrote ${path}`;
  });
}

function quote(key: string): string {
  return `'${key.replace(/['\\]/g, '\\$&')}'`;
}
