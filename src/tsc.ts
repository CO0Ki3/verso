// Finds the project's TypeScript and runs tsc once. `--listFiles` makes the same run print the program's files after
// the diagnostics, so no second pass is needed to learn which files to scan for blocks.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export interface Tsc {
  /** Absolute path of the tsc script. */
  path: string;
  version: string;
}

export interface TscRun {
  /** Exit code, or `null` when tsc was killed or could not start. */
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

/** The TypeScript that the project at `projectDir` resolves, or else the one installed next to verso. */
export function findTsc(projectDir: string): Tsc | undefined {
  for (const base of [join(projectDir, 'package.json'), import.meta.filename]) {
    let manifest: string;
    try {
      manifest = createRequire(base).resolve('typescript/package.json');
    } catch {
      continue;
    }
    const { bin, version } = JSON.parse(readFileSync(manifest, 'utf8')) as {
      bin?: string | Record<string, string>;
      version: string;
    };
    const script = typeof bin === 'string' ? bin : bin?.['tsc'];
    if (script !== undefined) return { path: resolve(dirname(manifest), script), version };
  }
  return undefined;
}

export function runTsc(tsc: Tsc, project: string, cwd: string): TscRun {
  const args = [tsc.path, '-p', project, '--noEmit', '--pretty', 'false', '--listFiles', '--noErrorTruncation'];
  // Composite and incremental projects write tsconfig.tsbuildinfo even under --noEmit, so it goes to a temporary
  // directory instead. Before TypeScript 5.6, tsc rejects the option in projects that are neither.
  const scratch = atLeast(tsc.version, 5, 6) ? mkdtempSync(join(tmpdir(), 'verso-')) : undefined;
  if (scratch !== undefined) args.push('--tsBuildInfoFile', join(scratch, 'tsconfig.tsbuildinfo'));
  // `noCheck` in the tsconfig (TypeScript 5.6 and later) would skip the checker and leave every block unchecked.
  // Earlier versions reject the option, in the tsconfig as on the command line.
  if (atLeast(tsc.version, 5, 6)) args.push('--noCheck', 'false');
  // TypeScript 7 is a Go program and takes its working directory from PWD when PWD names the same directory, so a
  // shell's PWD with unresolved symlinks would make it print paths relative to a directory other than `cwd`.
  const env = { ...process.env, PWD: cwd };
  try {
    const child = spawnSync(process.execPath, args, { cwd, env, encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024 });
    return {
      status: child.status,
      stdout: child.stdout,
      stderr: child.stderr,
      ...(child.error === undefined ? {} : { error: child.error }),
    };
  } finally {
    if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
  }
}

function atLeast(version: string, major: number, minor: number): boolean {
  const [actualMajor = 0, actualMinor = 0] = version.split('.').map((part) => Number.parseInt(part, 10));
  return actualMajor > major || (actualMajor === major && actualMinor >= minor);
}
