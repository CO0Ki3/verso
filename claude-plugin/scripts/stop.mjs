#!/usr/bin/env node
// Stop hook: before Claude finishes, runs verso on each verso package with changed TypeScript files and sends Claude
// back to work if a block fails, verso reports a problem, a changed file has a type error, or an exported function or
// generic type alias that Claude added or changed has no block. Exports that were already there are left alone, so a
// package can adopt verso one function at a time. A stop that this hook already sent back once is let through, so it
// cannot loop.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';

import { packageOf, usesVerso } from './packages.mjs';

const SOURCE = /\.(?:[cm]?ts|tsx)$/;
const DECLARATION = /\.d\.(?:[^\\/]*\.)?[cm]?ts$/;
/** Issues listed per package; the rest are counted. */
const LIMIT = 20;

const input = readInput();
if (input.stop_hook_active === true) process.exit(0);

const cwd = typeof input.cwd === 'string' ? input.cwd : (process.env.CLAUDE_PROJECT_DIR ?? process.cwd());
const root = git(cwd, ['rev-parse', '--show-toplevel'])?.trim();
if (!root) process.exit(0);

// Changed TypeScript sources of verso packages, by package, each with the line ranges that changed, or `undefined`
// for a file that is new as a whole.
const byPackage = new Map();
for (const [path, lines] of changedFiles(root)) {
  if (!SOURCE.test(path) || DECLARATION.test(path)) continue;
  const dir = packageOf(path, root);
  if (dir === undefined || !usesVerso(dir)) continue;
  if (!byPackage.has(dir)) byPackage.set(dir, new Map());
  byPackage.get(dir).set(relative(dir, path), lines);
}

const sections = [];
for (const [dir, files] of byPackage) {
  const issues = check(dir, files);
  if (issues.length === 0) continue;
  const listed = issues.slice(0, LIMIT).map((issue) => `- ${issue}`);
  if (issues.length > LIMIT) listed.push(`- and ${issues.length - LIMIT} more: run \`npx verso --json\` there`);
  sections.push([`${relative(root, dir) || '.'} (run \`npx verso\` there):`, ...listed].join('\n'));
}

if (sections.length > 0) {
  const reason = [
    'verso found work left in the packages you changed. Finish it before you stop; the verso:type-tests skill has',
    'the block format and what to assert.',
    '',
    sections.join('\n\n'),
  ].join('\n');
  process.stdout.write(`${JSON.stringify({ decision: 'block', reason })}\n`);
}

/** What is left to do in the package at `dir`, given its changed files (paths relative to `dir`). */
function check(dir, files) {
  const bin = versoBin(dir);
  if (bin === undefined) return [];
  const run = spawnSync(process.execPath, [bin, '--json'], {
    cwd: dir,
    env: { ...process.env, PWD: dir },
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  let result;
  try {
    result = JSON.parse(run.stdout);
  } catch {
    // verso could not run at all, for example without a tsconfig; there is nothing to point Claude at.
    return [];
  }

  const issues = [];
  if (result.typeChecked === false) {
    issues.push('tsc stopped before type checking because of syntax or compiler option errors; fix those first');
  }
  for (const block of result.blocks) {
    if (block.status !== 'failed') continue;
    const [first, ...rest] = block.diagnostics;
    const more = rest.length > 0 ? ` (and ${rest.length} more)` : '';
    issues.push(
      `fix the failing block ${block.file}:${block.line} ${block.name}: ${first.code} ${first.message}${more}`,
    );
  }
  for (const problem of result.problems) {
    if (problem.file !== undefined && !files.has(problem.file)) continue;
    const where =
      problem.file === undefined ? '' : `${problem.file}${problem.line === undefined ? '' : `:${problem.line}`} `;
    issues.push(`fix ${where}${problem.message}`);
  }
  for (const diagnostic of result.outside) {
    if (!files.has(diagnostic.file)) continue;
    issues.push(
      `fix the type error ${diagnostic.file}:${diagnostic.line}:${diagnostic.column} ${diagnostic.code} ${diagnostic.message}`,
    );
  }
  for (const exported of result.uncovered) {
    if (!files.has(exported.file)) continue;
    const lines = files.get(exported.file);
    if (lines !== undefined && !lines.some(([from, to]) => from <= exported.line && exported.line <= to)) continue;
    const kind = exported.kind === 'type' ? 'generic type alias' : 'function';
    issues.push(
      `add a \`// @verso\` block for the exported ${kind} ${exported.name} (${exported.file}:${exported.line})`,
    );
  }
  return issues;
}

/** Changed files under `top`, absolute, each with its changed line ranges or `undefined` when new as a whole. */
function changedFiles(top) {
  const files = new Map();
  const hasHead = git(top, ['rev-parse', '--verify', '--quiet', 'HEAD']) !== undefined;
  const entries = (git(top, ['status', '--porcelain=v1', '-z', '--untracked-files=all']) ?? '').split('\0');
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    // A rename or copy is followed by the path it came from.
    if (code[0] === 'R' || code[0] === 'C') index++;
    if (code.includes('D')) continue;
    const added = code === '??' || code[0] === 'A' || !hasHead;
    files.set(join(top, path), added ? undefined : changedLines(top, path));
  }
  return files;
}

/** The line ranges, inclusive, that a file changed since HEAD, staged or not. */
function changedLines(top, path) {
  const diff = git(top, ['diff', '--no-color', '--no-ext-diff', '--unified=0', 'HEAD', '--', path]) ?? '';
  const ranges = [];
  for (const match of diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    if (count > 0) ranges.push([start, start + count - 1]);
  }
  return ranges;
}

/** The verso command the package at `dir` installed, or `undefined`. */
function versoBin(dir) {
  try {
    const manifest = createRequire(join(dir, 'package.json')).resolve('verso-ts/package.json');
    const { bin } = JSON.parse(readFileSync(manifest, 'utf8'));
    const path = typeof bin === 'string' ? bin : bin?.verso;
    return path === undefined ? undefined : resolve(dirname(manifest), path);
  } catch {
    return undefined;
  }
}

function git(dir, args) {
  const run = spawnSync('git', args, { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return run.status === 0 ? run.stdout : undefined;
}

function readInput() {
  if (process.stdin.isTTY) return {};
  try {
    return JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    return {};
  }
}
