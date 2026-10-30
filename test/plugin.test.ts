// Runs the Claude Code plugin's hook scripts against a temporary git repository holding a package that uses verso.

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { envFile, helperFile } from '../src/init.ts';

const SCRIPTS = join(import.meta.dirname, '../claude-plugin/scripts');
const CLI = pathToFileURL(join(import.meta.dirname, '../src/cli.ts')).href;

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: 'es2022',
    lib: ['es2022'],
    module: 'nodenext',
    types: [],
    strict: true,
    allowImportingTsExtensions: true,
    noEmit: true,
  },
  include: ['src'],
});

const OLD = `import type { Equal, Expect } from './verso.ts';

export function old(value: number): number {
  return value;
}
`;

let root: string;
const repos: string[] = [];

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'verso-plugin-'));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(base: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(base, path)), { recursive: true });
    writeFileSync(join(base, path), content);
  }
}

function git(cwd: string, ...args: string[]): void {
  const run = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
  if (run.status !== 0) throw new Error(run.stderr);
}

/** A git repository with a committed verso package at packages/lib and a package without verso at packages/plain. */
function repository(): string {
  const repo = mkdtempSync(join(root, 'repo-'));
  repos.push(repo);
  write(repo, {
    'package.json': JSON.stringify({ name: 'root', private: true }),
    // A stand-in for the installed package: its bin runs this repository's CLI.
    'node_modules/verso-ts/package.json': JSON.stringify({ name: 'verso-ts', bin: { verso: './cli.mjs' } }),
    'node_modules/verso-ts/cli.mjs': `import ${JSON.stringify(CLI)};\n`,
    'packages/lib/package.json': JSON.stringify({ name: 'lib', devDependencies: { 'verso-ts': '*' } }),
    'packages/lib/tsconfig.json': TSCONFIG,
    'packages/lib/src/verso.ts': helperFile('lib', true),
    'packages/lib/src/verso.env.d.ts': envFile('lib'),
    'packages/lib/src/old.ts': OLD,
    'packages/plain/package.json': JSON.stringify({ name: 'plain' }),
    'packages/plain/src/index.ts': 'export function plain() {}\n',
  });
  git(repo, 'init', '-q');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  return repo;
}

function stop(repo: string, input: Record<string, unknown> = {}): { decision?: string; reason?: string } | undefined {
  const run = spawnSync(process.execPath, [join(SCRIPTS, 'stop.mjs')], {
    input: JSON.stringify({ hook_event_name: 'Stop', stop_hook_active: false, cwd: repo, ...input }),
    encoding: 'utf8',
    env: { ...process.env, PWD: repo },
  });
  expect(run.status).toBe(0);
  return run.stdout.trim() === '' ? undefined : (JSON.parse(run.stdout) as { decision?: string; reason?: string });
}

describe('the Stop hook', { timeout: 60_000 }, () => {
  it('lets Claude stop when nothing changed', () => {
    expect(stop(repository())).toBeUndefined();
  });

  it('sends Claude back for a new export without a block, but not for exports that were already there', () => {
    const repo = repository();
    write(repo, {
      'packages/lib/src/fresh.ts': 'export const fresh = (value: string): string => value;\n',
      'packages/lib/src/old.ts': `${OLD}\nexport function added(): void {}\n`,
    });
    const output = stop(repo);
    expect(output?.decision).toBe('block');
    expect(output?.reason).toContain('packages/lib (run `npx verso` there):');
    expect(output?.reason).toContain('add a `// @verso` block for the exported function fresh (src/fresh.ts:1)');
    expect(output?.reason).toContain('add a `// @verso` block for the exported function added (src/old.ts:7)');
    expect(output?.reason).not.toContain(' old ');
  });

  it('lets Claude stop once the new exports have passing blocks', () => {
    const repo = repository();
    write(repo, {
      'packages/lib/src/fresh.ts': `import type { Equal, Expect } from './verso.ts';

export const fresh = (value: string): string => value;

// @verso fresh
declare type _fresh = [Expect<Equal<ReturnType<typeof fresh>, string>>];
`,
    });
    expect(stop(repo)).toBeUndefined();
  });

  it('sends Claude back for a failing block and a type error in a changed file', () => {
    const repo = repository();
    write(repo, {
      'packages/lib/src/old.ts': `${OLD}
export const wrong: string = 1;

// @verso old
declare type _old = [Expect<Equal<ReturnType<typeof old>, string>>];
`,
    });
    const reason = stop(repo)?.reason ?? '';
    expect(reason).toContain(
      "fix the failing block src/old.ts:9 old: TS2344 Type '{ actual: number; expected: string; }' does not satisfy the constraint 'true'.",
    );
    expect(reason).toContain(
      "fix the type error src/old.ts:7:14 TS2322 Type 'number' is not assignable to type 'string'.",
    );
  });

  it('lets a second stop through, so it cannot loop', () => {
    const repo = repository();
    write(repo, { 'packages/lib/src/fresh.ts': 'export function fresh() {}\n' });
    expect(stop(repo, { stop_hook_active: true })).toBeUndefined();
  });

  it('ignores packages without verso and repositories without git', () => {
    const repo = repository();
    write(repo, { 'packages/plain/src/more.ts': 'export function more() {}\n' });
    expect(stop(repo)).toBeUndefined();
    const loose = mkdtempSync(join(root, 'loose-'));
    expect(stop(loose)).toBeUndefined();
  });
});

const sessionStart = (dir: string): string =>
  spawnSync(process.execPath, [join(SCRIPTS, 'session-start.mjs')], {
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
  }).stdout;

describe('the SessionStart hook', () => {
  it('names the packages that use verso', () => {
    expect(sessionStart(repository())).toMatch(
      /^This repository uses verso for in-source type tests, in: packages\/lib\.\n/,
    );
  });

  it('says nothing in a repository without verso', () => {
    const dir = mkdtempSync(join(root, 'none-'));
    write(dir, { 'package.json': JSON.stringify({ name: 'none' }) });
    expect(sessionStart(dir)).toBe('');
  });
});
