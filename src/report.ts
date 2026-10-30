// Formats a check for the terminal. Failures always print; passing blocks print only with `--verbose`.

import { relative } from 'node:path';
import { styleText } from 'node:util';

import type { Assignment } from './assign.ts';
import type { Diagnostic } from './diagnostics.ts';

/** A problem verso found itself, in a file or, without a location, in the project as a whole. */
export interface ReportedProblem {
  file?: string;
  line?: number;
  message: string;
}

export interface ReportInput {
  /** Paths print relative to this directory. */
  cwd: string;
  assignment: Assignment;
  problems: readonly ReportedProblem[];
  /** Number of files tsc listed for the program. */
  programFiles: number;
  /** Number of project source files scanned for blocks. */
  scannedFiles: number;
  /** Whether tsc got as far as type checking; when it did not, blocks without diagnostics were never checked. */
  typeChecked: boolean;
  /** Output lines verso could not read; printed so that nothing tsc said goes missing. */
  unrecognized: readonly string[];
  verbose: boolean;
  color: boolean;
}

export interface Report {
  text: string;
  /** Whether the check passed: every block checked and passing, at least one block, no problem, no other error. */
  ok: boolean;
}

type Style = Parameters<typeof styleText>[0];

export function formatReport(input: ReportInput): Report {
  const { cwd, assignment, problems, verbose } = input;
  const paint = (style: Style, text: string): string =>
    input.color ? styleText(style, text, { validateStream: false }) : text;
  const where = (file: string): string => relative(cwd, file) || file;
  const sections: string[][] = [];

  const blockLines: string[] = [];
  let failed = 0;
  let unchecked = 0;
  let assertions = 0;
  for (const { file, block, diagnostics } of assignment.results) {
    assertions += block.assertions;
    const location = `${where(file)}:${block.line}`;
    if (diagnostics.length > 0) {
      failed++;
      blockLines.push(`${paint('red', '✗')} ${location}  ${paint('bold', block.name)}`);
      for (const diagnostic of diagnostics) {
        blockLines.push(...formatDiagnostic(diagnostic, `${diagnostic.line}:${diagnostic.column}`, paint));
      }
    } else if (!input.typeChecked) {
      unchecked++;
      if (verbose)
        blockLines.push(`${paint('yellow', '?')} ${location}  ${block.name}  ${paint('dim', 'not checked')}`);
    } else if (verbose) {
      blockLines.push(
        `${paint('green', '✓')} ${location}  ${block.name}  ${paint('dim', count(block.assertions, 'assertion'))}`,
      );
    }
  }
  if (blockLines.length > 0) sections.push(blockLines);

  if (problems.length > 0) {
    sections.push([
      paint('yellow', `Problems: ${problems.length}`),
      ...problems.map(({ file, line, message }) =>
        file === undefined ? `    ${message}` : `    ${where(file)}${line === undefined ? '' : `:${line}`}  ${message}`,
      ),
    ]);
  }

  const { outside } = assignment;
  if (outside.length > 0) {
    sections.push([
      paint('yellow', `Errors outside blocks: ${outside.length}`),
      ...outside.flatMap((diagnostic) =>
        formatDiagnostic(
          diagnostic,
          diagnostic.file === undefined ? '' : `${where(diagnostic.file)}:${diagnostic.line}:${diagnostic.column}`,
          paint,
        ),
      ),
    ]);
  }

  if (!input.typeChecked) {
    sections.push([
      'tsc stopped before type checking because of syntax or compiler option errors, so blocks without errors were ' +
        'not checked. Fix those errors first.',
    ]);
  }

  if (input.unrecognized.length > 0) {
    sections.push([paint('yellow', 'Unrecognized tsc output:'), ...input.unrecognized.map((line) => `    ${line}`)]);
  }

  const total = assignment.results.length;
  if (total === 0) {
    sections.push([
      input.programFiles === 0
        ? 'No verso blocks found: tsc listed no files. A solution-style tsconfig (`"files": []` with `references`) ' +
          'checks nothing itself; pass one of the referenced projects with -p.'
        : `No verso blocks found in ${count(input.scannedFiles, 'source file')}. Write one after \`verso init\`.`,
    ]);
  }
  const passed = total - failed - unchecked;
  const counts = `${count(total, 'block')}: ${passed} passed, ${failed} failed`;
  const summary = [unchecked > 0 ? `${counts}, ${unchecked} not checked` : counts, count(assertions, 'assertion')];
  if (problems.length > 0) summary.push(count(problems.length, 'problem'));
  if (outside.length > 0) summary.push(`${outside.length} outside blocks`);
  sections.push([summary.join(' · ')]);

  return {
    text: sections.map((lines) => lines.join('\n')).join('\n\n') + '\n',
    ok: total > 0 && passed === total && problems.length === 0 && outside.length === 0,
  };
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
