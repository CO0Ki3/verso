#!/usr/bin/env node
// SessionStart hook: tells Claude which packages of the repository use verso, so that it writes type tests there
// without being asked. Prints nothing in a repository without verso, so the plugin stays out of the way there.

import { relative } from 'node:path';

import { versoPackages } from './packages.mjs';

const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const packages = versoPackages(root).map((dir) => relative(root, dir) || '.');

if (packages.length > 0) {
  process.stdout.write(
    [
      `This repository uses verso for in-source type tests, in: ${packages.join(', ')}.`,
      'When you add an exported function or generic type alias there, or change its signature, add or update its',
      '`// @verso` block in the same file, right after the declaration, and run `npx verso` in that package before',
      'you finish. The verso:type-tests skill has the format and what to assert.',
      '',
    ].join('\n'),
  );
}
