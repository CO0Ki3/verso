// Parses the output of `tsc --pretty false --listFiles`: diagnostics, each possibly followed by indented
// continuation lines, and the absolute paths of the files in the program. TypeScript 5 and 7 print the same layout.

import { isAbsolute, resolve } from 'node:path';

export interface Diagnostic {
  /** Absolute path. Absent for diagnostics without a location, such as compiler option errors. */
  file?: string;
  /** 1-based line. */
  line?: number;
  /** 1-based column. */
  column?: number;
  /** For example `TS2344`. */
  code: string;
  /** `error` in practice; tsc prints no other category on the command line. */
  category: string;
  /** First line of the message. */
  message: string;
  /** Continuation lines of a message chain, without the two-space indent tsc puts in front of each. */
  details: string[];
}

export interface TscOutput {
  diagnostics: Diagnostic[];
  /** Absolute paths of the files in the program, in the order tsc listed them. */
  files: string[];
  /** Lines that matched nothing, kept so that unexpected output is never silently dropped. */
  unrecognized: string[];
}

const LOCATED = /^(.+?)\((\d+),(\d+)\): (error|warning|suggestion|message) (TS\d+): (.*)$/;
const UNLOCATED = /^(error|warning|suggestion|message) (TS\d+): (.*)$/;

/** Parses tsc output. Relative diagnostic paths are resolved against `cwd`, the directory tsc ran in. */
export function parseTscOutput(output: string, cwd: string): TscOutput {
  const result: TscOutput = { diagnostics: [], files: [], unrecognized: [] };
  let current: Diagnostic | undefined;
  for (const line of output.split(/\r?\n/)) {
    if (line.trim() === '') {
      current = undefined;
      continue;
    }
    const located = LOCATED.exec(line);
    if (located !== null) {
      const [, file, row, column, category, code, message] = located;
      current = {
        file: resolve(cwd, file!),
        line: Number(row),
        column: Number(column),
        code: code!,
        category: category!,
        message: message!,
        details: [],
      };
      result.diagnostics.push(current);
      continue;
    }
    const unlocated = UNLOCATED.exec(line);
    if (unlocated !== null) {
      const [, category, code, message] = unlocated;
      current = { code: code!, category: category!, message: message!, details: [] };
      result.diagnostics.push(current);
      continue;
    }
    if (current !== undefined && /^\s/.test(line)) {
      current.details.push(line.startsWith('  ') ? line.slice(2) : line.trimStart());
      continue;
    }
    current = undefined;
    if (isAbsolute(line)) result.files.push(line);
    else result.unrecognized.push(line);
  }
  return result;
}

/** Problems tsc finds before type checking that are not numbered with syntax or option errors. */
const EARLY = new Set(['TS2318', 'TS2688', 'TS18003']);
/** Syntax errors (1xxx, 8xxx for TypeScript syntax in JS files, 17xxx for JSX) and option errors (5xxx, 6xxx). */
const EARLY_CODE = /^TS(?:1|5|6|8|17)\d{3}$/;
/** Unused-declaration errors are numbered with option errors but come from type checking. */
const UNUSED = new Set(['TS6133', 'TS6138', 'TS6192', 'TS6196', 'TS6198', 'TS6199', 'TS6205']);

/**
 * Whether tsc got as far as type checking. It stops short of the checker when it finds syntax or compiler option
 * errors and then prints only those, so a block without diagnostics has not been checked at all.
 *
 * tsc does not say which phase a diagnostic comes from, so this goes by code, and any other diagnostic in a source
 * file proves that the checker ran. A syntax error in a tsconfig file, which is not among `programFiles`, does not
 * stop the checker; one in a JSON module, which is, does. The guess errs toward "not checked": an unknown option in
 * tsconfig.json does not stop the checker either, but looks like an option error that does.
 */
export function typeCheckRan(diagnostics: readonly Diagnostic[], programFiles: ReadonlySet<string>): boolean {
  let stopped = false;
  for (const { file, code } of diagnostics) {
    const config = file !== undefined && file.endsWith('.json') && !programFiles.has(file);
    const syntaxInConfig = config && /^TS1\d{3}$/.test(code);
    if (file === undefined || EARLY.has(code) || (EARLY_CODE.test(code) && !UNUSED.has(code) && !syntaxInConfig)) {
      stopped = true;
    } else if (!config) {
      return true;
    }
  }
  return !stopped;
}
