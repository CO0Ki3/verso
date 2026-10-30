// Turns a check into its result, which `--json` prints as is, and formats that result for the terminal. On the
// terminal, failures always print; passing blocks and exports without a block print only with `--verbose`.

import { relative } from 'node:path';
import { styleText } from 'node:util';

import type { Assignment } from './assign.ts';
import type { Diagnostic } from './diagnostics.ts';
import type { Exported } from './exports.ts';

/** A problem verso found itself, in a file or, without a location, in the project as a whole. */
export interface ReportedProblem {
  file?: string;
  line?: number;
  message: string;
}

export interface ReportInput {
  /** Paths in the result are relative to this directory. */
  cwd: string;
  assignment: Assignment;
  problems: readonly ReportedProblem[];
  /** Exported functions and generic types that no block in their file mentions. */
  uncovered: readonly (Exported & { file: string })[];
  /** Number of files tsc listed for the program. */
  programFiles: number;
  /** Number of project source files scanned for blocks. */
  scannedFiles: number;
  /** Whether tsc got as far as type checking; when it did not, blocks without diagnostics were never checked. */
  typeChecked: boolean;
  /** Output lines verso could not read; reported so that nothing tsc said goes missing. */
  unrecognized: readonly string[];
}

export interface CheckResult {
  /** Whether the check passed: every block checked and passing, at least one block, no problem, no other error. */
  ok: boolean;
  typeChecked: boolean;
  blocks: {
    file: string;
    line: number;
    endLine: number;
    name: string;
    assertions: number;
    status: 'passed' | 'failed' | 'unchecked';
    diagnostics: Diagnostic[];
  }[];
  problems: ReportedProblem[];
  /** Diagnostics on no block's lines. */
  outside: Diagnostic[];
  /** Exported functions and generic types without a block. They do not fail the check. */
  uncovered: (Exported & { file: string })[];
  unrecognized: string[];
  programFiles: number;
  scannedFiles: number;
  summary: { blocks: number; passed: number; failed: number; unchecked: number; assertions: number };
}

export function checkResult(input: ReportInput): CheckResult {
  const where = (file: string): string => relative(input.cwd, file) || file;
  const located = (diagnostic: Diagnostic): Diagnostic =>
    diagnostic.file === undefined ? diagnostic : { ...diagnostic, file: where(diagnostic.file) };

  const blocks = input.assignment.results.map(({ file, block, diagnostics }) => ({
    file: where(file),
    line: block.line,
    endLine: block.endLine,
    name: block.name,
    assertions: block.assertions,
    status: diagnostics.length > 0 ? 'failed' : input.typeChecked ? 'passed' : 'unchecked',
    diagnostics: diagnostics.map(located),
  })) satisfies CheckResult['blocks'];
  const withStatus = (status: string): number => blocks.filter((block) => block.status === status).length;
  const summary = {
    blocks: blocks.length,
    passed: withStatus('passed'),
    failed: withStatus('failed'),
    unchecked: withStatus('unchecked'),
    assertions: blocks.reduce((sum, block) => sum + block.assertions, 0),
  };
  const problems = input.problems.map((problem) =>
    problem.file === undefined ? problem : { ...problem, file: where(problem.file) },
  );
  const outside = input.assignment.outside.map(located);
  return {
    ok: summary.blocks > 0 && summary.passed === summary.blocks && problems.length === 0 && outside.length === 0,
    typeChecked: input.typeChecked,
    blocks,
    problems,
    outside,
    uncovered: input.uncovered.map((exported) => ({ ...exported, file: where(exported.file) })),
    unrecognized: [...input.unrecognized],
    programFiles: input.programFiles,
    scannedFiles: input.scannedFiles,
    summary,
  };
}

type Style = Parameters<typeof styleText>[0];

export function formatText(result: CheckResult, options: { verbose: boolean; color: boolean }): string {
  const paint = (style: Style, text: string): string =>
    options.color ? styleText(style, text, { validateStream: false }) : text;
  const sections: string[][] = [];

  const blockLines: string[] = [];
  for (const block of result.blocks) {
    const location = `${block.file}:${block.line}`;
    if (block.status === 'failed') {
      blockLines.push(`${paint('red', '✗')} ${location}  ${paint('bold', block.name)}`);
      for (const diagnostic of block.diagnostics) {
        blockLines.push(...formatDiagnostic(diagnostic, `${diagnostic.line}:${diagnostic.column}`, paint));
      }
    } else if (!options.verbose) {
      continue;
    } else if (block.status === 'unchecked') {
      blockLines.push(`${paint('yellow', '?')} ${location}  ${block.name}  ${paint('dim', 'not checked')}`);
    } else {
      blockLines.push(
        `${paint('green', '✓')} ${location}  ${block.name}  ${paint('dim', count(block.assertions, 'assertion'))}`,
      );
    }
  }
  if (blockLines.length > 0) sections.push(blockLines);

  const { problems, outside } = result;
  if (problems.length > 0) {
    sections.push([
      paint('yellow', `Problems: ${problems.length}`),
      ...problems.map(({ file, line, message }) =>
        file === undefined ? `    ${message}` : `    ${file}${line === undefined ? '' : `:${line}`}  ${message}`,
      ),
    ]);
  }

  if (outside.length > 0) {
    sections.push([
      paint('yellow', `Errors outside blocks: ${outside.length}`),
      ...outside.flatMap((diagnostic) =>
        formatDiagnostic(
          diagnostic,
          diagnostic.file === undefined ? '' : `${diagnostic.file}:${diagnostic.line}:${diagnostic.column}`,
          paint,
        ),
      ),
    ]);
  }

  if (options.verbose && result.uncovered.length > 0) {
    sections.push([
      paint('yellow', `Exports without a block: ${result.uncovered.length}`),
      ...result.uncovered.map(({ file, line, name }) => `    ${file}:${line}  ${name}`),
    ]);
  }

  if (!result.typeChecked) {
    sections.push([
      'tsc stopped before type checking because of syntax or compiler option errors, so blocks without errors were ' +
        'not checked. Fix those errors first.',
    ]);
  }

  if (result.unrecognized.length > 0) {
    sections.push([paint('yellow', 'Unrecognized tsc output:'), ...result.unrecognized.map((line) => `    ${line}`)]);
  }

  const { summary } = result;
  if (summary.blocks === 0) {
    sections.push([
      result.programFiles === 0
        ? 'No verso blocks found: tsc listed no files. A solution-style tsconfig (`"files": []` with `references`) ' +
          'checks nothing itself; pass one of the referenced projects with -p.'
        : `No verso blocks found in ${count(result.scannedFiles, 'source file')}. Write one after \`verso init\`.`,
    ]);
  }
  const counts = `${count(summary.blocks, 'block')}: ${summary.passed} passed, ${summary.failed} failed`;
  const line = [
    summary.unchecked > 0 ? `${counts}, ${summary.unchecked} not checked` : counts,
    count(summary.assertions, 'assertion'),
  ];
  if (problems.length > 0) line.push(count(problems.length, 'problem'));
  if (outside.length > 0) line.push(`${outside.length} outside blocks`);
  sections.push([line.join(' · ')]);

  return sections.map((lines) => lines.join('\n')).join('\n\n') + '\n';
}

function formatDiagnostic(
  diagnostic: Diagnostic,
  location: string,
  paint: (style: Style, text: string) => string,
): string[] {
  const prefix = `    ${location === '' ? '' : `${location}  `}`;
  const indent = ' '.repeat(prefix.length + diagnostic.code.length + 2);
  return [
    `${prefix}${paint('dim', diagnostic.code)}  ${diagnostic.message}`,
    ...diagnostic.details.map((detail) => indent + detail),
  ];
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}
