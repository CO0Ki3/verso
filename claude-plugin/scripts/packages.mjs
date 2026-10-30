// Finds the packages that use verso: those whose package.json lists `verso-ts` as a dependency of any kind.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

const FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

/** Whether the package at `dir` lists verso-ts. */
export function usesVerso(dir) {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    return FIELDS.some((field) => manifest[field]?.['verso-ts'] !== undefined);
  } catch {
    return false;
  }
}

/**
 * The packages under `root` that use verso, `root` itself included, down to `depth` directory levels: enough for
 * monorepo layouts such as `packages/<name>` and `apps/<group>/<name>`. Dot directories and node_modules are skipped.
 */
export function versoPackages(root, depth = 3) {
  const found = [];
  const visit = (dir, level) => {
    if (usesVerso(dir)) found.push(dir);
    if (level === depth) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== 'node_modules' && !entry.name.startsWith('.')) {
        visit(join(dir, entry.name), level + 1);
      }
    }
  };
  visit(root, 0);
  return found.toSorted();
}

/** The nearest directory from the file at `path` up to `root` that holds a package.json, or `undefined`. */
export function packageOf(path, root) {
  for (let dir = dirname(path); ; dir = dirname(dir)) {
    try {
      readFileSync(join(dir, 'package.json'));
      return dir;
    } catch {
      // Not a package; keep going up.
    }
    if (relative(root, dir) === '' || dirname(dir) === dir) return undefined;
  }
}
