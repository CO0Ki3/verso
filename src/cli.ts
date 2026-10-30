#!/usr/bin/env node
// verso: type-checks a project with tsc and reports its in-source type tests (`// @verso` blocks) by name.
// `verso init` writes the files a package needs before its first block.
//
// Exit codes: 0 when every block passes; 1 when a block fails or goes unchecked, verso finds a problem (a malformed
// block, a gate that is not enabled, a helper import that survives in JS), tsc reports an error outside blocks, or no
// block exists at all; and 2 when verso itself cannot run (bad arguments, no tsconfig, no TypeScript, tsc crashed).

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';

import { assign, type SourceFile } from './assign.ts';
import { parseBlocks } from './blocks.ts';
import { parseTscOutput, typeCheckRan } from './diagnostics.ts';
import { findExports, mentions, type Exported } from './exports.ts';
import { enabledKeys, ENV_FILE, gatedKeys } from './gate.ts';
import { init } from './init.ts';
import { checkResult, formatText, type ReportedProblem } from './report.ts';
import { lineStarts } from './tokens.ts';
import { findTsc, runTsc } from './tsc.ts';

const USAGE = `Usage: verso [-p <tsconfig>] [--verbose] [--json]
       verso init [--dir <dir>] [--key <key>] [--standalone]

verso type-checks the project with tsc and reports its in-source type tests (// @verso blocks) by name.

  -p, --project <path>  tsconfig.json, or a directory holding one (default: tsconfig.json)
      --verbose         also list passing blocks, and exported functions and generic types without a block
      --json            print the result as JSON, for tools and coding agents

verso init writes the helper file that blocks import (verso.ts) and verso.env.d.ts, which turns the blocks on in
the package's own program and nowhere else.

      --dir <dir>       directory that receives both files (default: src)
      --key <key>       key of the package (default: its name in package.json)
      --standalone      copy the helpers instead of importing them from 'verso-ts'

  -h, --help            show this help
  -v, --version         show the version
`;

/** Files that can hold blocks: TypeScript sources, not declaration files. */
const SOURCE = /\.(?:[cm]?ts|tsx)$/;
/** Test files, whose exports need no block. */
const TEST = /\.(?:test|spec)\.[cm]?tsx?$|(?:^|[\\/])__tests__[\\/]/;
const DECLARATION = /\.d\.(?:[^\\/]*\.)?[cm]?ts$/;
const DEPENDENCY = /(?:^|[\\/])node_modules[\\/]/;

function main(args: string[]): number {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      options: {
        project: { type: 'string', short: 'p' },
        verbose: { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        dir: { type: 'string', default: 'src' },
        key: { type: 'string' },
        standalone: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
        version: { type: 'boolean', short: 'v', default: false },
      },
    });
  } catch (error) {
    return usageError((error as Error).message);
  }
  const { values: options, positionals } = parsed;
  if (options.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (options.version) {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string;
    };
    process.stdout.write(`${manifest.version}\n`);
    return 0;
  }

  const [command, ...rest] = positionals;
  if (rest.length > 0 || (command !== undefined && command !== 'init')) {
    return usageError(`unknown command '${positionals.join(' ')}'`);
  }
  if (command === 'init') {
    const cwd = process.cwd();
    const key = options.key ?? packageName(cwd) ?? basename(cwd);
    for (const line of init(resolve(cwd, options.dir), key, options.standalone)) {
      process.stdout.write(`${line.replace(cwd + sep, '')}\n`);
    }
    process.stdout.write(
      `Make sure the tsconfig includes ${join(options.dir, 'verso.env.d.ts')}, and that nothing imports it.\n`,
    );
    return 0;
  }
  return check(options.project ?? 'tsconfig.json', options.verbose, options.json);
}

function check(projectOption: string, verbose: boolean, json: boolean): number {
  const cwd = process.cwd();
  let project = resolve(cwd, projectOption);
  if (existsSync(project) && statSync(project).isDirectory()) project = join(project, 'tsconfig.json');
  if (!existsSync(project)) {
    process.stderr.write(`verso: cannot find ${relative(cwd, project) || project}\n`);
    return 2;
  }
  const projectDir = dirname(project);

  const tsc = findTsc(projectDir);
  if (tsc === undefined) {
    process.stderr.write('verso: cannot find TypeScript; add `typescript` to the project\n');
    return 2;
  }
  if (verbose && !json) {
    process.stdout.write(`TypeScript ${tsc.version} (${relative(cwd, tsc.path) || tsc.path})\n\n`);
  }

  const run = runTsc(tsc, project, cwd);
  const output = parseTscOutput(run.stdout, cwd);
  if (run.error !== undefined || run.status === null || (run.status !== 0 && output.diagnostics.length === 0)) {
    const reason = run.error?.message ?? (run.status === null ? 'it was killed' : `it exited with ${run.status}`);
    process.stderr.write(`verso: tsc failed: ${reason}\n${run.stdout}${run.stderr}`);
    return 2;
  }

  const realpaths = new Map<string, string>();
  const real = (path: string): string => {
    let result = realpaths.get(path);
    if (result === undefined) {
      try {
        result = realpathSync.native(path);
      } catch {
        result = path;
      }
      realpaths.set(path, result);
    }
    return result;
  };

  // Only the project's own files count. Files reached through node_modules or outside the tsconfig directory belong
  // to other packages, whose blocks are theirs to check. A file reached through two paths, such as a symlink, is
  // listed twice but counts once.
  const root = real(projectDir);
  const programFiles = new Set(output.files.map(real));
  const ownFiles = [...programFiles].filter((path) => {
    const inProject = relative(root, path);
    return !(
      inProject === '..' ||
      inProject.startsWith(`..${sep}`) ||
      isAbsolute(inProject) ||
      DEPENDENCY.test(inProject)
    );
  });

  const enabled = new Set<string>();
  const envFiles = ownFiles.filter((path) => ENV_FILE.test(path));
  for (const path of envFiles) for (const key of enabledKeys(readFileSync(path, 'utf8'))) enabled.add(key);

  const files: SourceFile[] = [];
  const gateProblems: ReportedProblem[] = [];
  const uncovered: (Exported & { file: string })[] = [];
  let scannedFiles = 0;
  for (const path of ownFiles) {
    if (!SOURCE.test(path) || DECLARATION.test(path)) continue;
    scannedFiles++;
    const source = readFileSync(path, 'utf8');
    const jsx = path.endsWith('.tsx');
    const { blocks, problems } = parseBlocks(source, { jsx });
    if (blocks.length > 0 || problems.length > 0) files.push({ path, blocks, problems });
    const gated = gatedKeys(source);
    for (const { key, line } of envFiles.length === 0 ? [] : gated) {
      if (enabled.has(key)) continue;
      gateProblems.push({
        file: path,
        line,
        message: `this \`Expect\` depends on the key '${key}', which no verso.env.d.ts in the program enables, so the blocks using it check nothing`,
      });
    }
    // Exports that no block in the same file mentions. Helper files and tests need no blocks.
    if (gated.length > 0 || TEST.test(path)) continue;
    const starts = lineStarts(source);
    const texts = blocks.map((block) => source.slice(starts[block.line - 1], starts[block.endLine] ?? source.length));
    for (const exported of findExports(source, { jsx })) {
      if (!texts.some((text) => mentions(text, exported.name))) uncovered.push({ file: path, ...exported });
    }
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const problems: ReportedProblem[] = [
    ...files.flatMap((file) => file.problems.map((problem) => ({ file: file.path, ...problem }))),
    ...gateProblems,
  ];
  if (envFiles.length === 0 && files.some((file) => file.blocks.length > 0)) {
    problems.push({
      message:
        'no verso.env.d.ts in the program, so `Expect` accepts anything and no block checks anything; run ' +
        '`verso init` and make sure the tsconfig includes the file',
    });
  }

  // The same diagnostic arrives once for each path tsc reached a file through.
  const seen = new Set<string>();
  const diagnostics = output.diagnostics
    .map((diagnostic) => (diagnostic.file === undefined ? diagnostic : { ...diagnostic, file: real(diagnostic.file) }))
    .filter((diagnostic) => {
      const key = JSON.stringify(diagnostic);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  uncovered.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
  const result = checkResult({
    cwd,
    assignment: assign(files, diagnostics),
    problems,
    uncovered,
    programFiles: output.files.length,
    scannedFiles,
    typeChecked: typeCheckRan(diagnostics, programFiles),
    unrecognized: [...output.unrecognized, ...run.stderr.split(/\r?\n/).filter((line) => line.trim() !== '')],
  });
  if (json) {
    process.stdout.write(`${JSON.stringify({ typescript: tsc.version, ...result }, null, 2)}\n`);
  } else {
    const color = process.stdout.isTTY === true && !process.env['NO_COLOR'];
    process.stdout.write(formatText(result, { verbose, color }));
  }
  return result.ok ? 0 : 1;
}

function packageName(dir: string): string | undefined {
  try {
    const { name } = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: unknown };
    return typeof name === 'string' && name !== '' ? name : undefined;
  } catch {
    return undefined;
  }
}

function usageError(message: string): number {
  process.stderr.write(`verso: ${message}\n\n${USAGE}`);
  return 2;
}

process.exitCode = main(process.argv.slice(2));
