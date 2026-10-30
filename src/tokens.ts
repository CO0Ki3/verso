// A small TypeScript tokenizer that knows just enough to find verso blocks. It separates comments, string literals,
// template literals, regular expression literals and, in TSX, JSX elements from code, so a marker or a bracket inside
// them is never taken for a real one. It never throws: malformed input only yields odd tokens.
//
// Some of it is guesswork, as in any tokenizer without a parser behind it. Whether `/` starts a regular expression,
// and whether `<` starts a JSX element, depends on whether an operand is expected at that point, which the previous
// tokens tell. An unterminated string or regular expression ends at the line break, and a JSX element whose closing
// tag never comes is read as a plain `<`, so a misread cannot swallow the rest of the file.

export type TokenKind = 'comment' | 'string' | 'template' | 'regex' | 'jsx' | 'word' | 'number' | 'punct';

export interface Token {
  kind: TokenKind;
  /** Offset of the first character. */
  start: number;
  /** Offset just past the last character. */
  end: number;
  /** Source text. A template literal or JSX element is one token, with its substitutions or children. */
  text: string;
}

export interface TokenizeOptions {
  /** Read JSX, as in a .tsx file. */
  jsx?: boolean;
}

const WHITESPACE = /\s/;
const LINE_BREAK = /[\n\r\u2028\u2029]/;
const DIGIT = /[0-9]/;
const NUMBER_PART = /[0-9A-Za-z_.]/;
// `#` starts a private name and `\` a unicode escape; both belong to the word that follows.
const WORD_START = /[\p{ID_Start}$_#\\]/u;
const WORD_PART = /[\p{ID_Continue}$\\]|\u200c|\u200d/u;
const JSX_NAME = /^[A-Za-z_$][\w$.:-]*/;
const IDENTIFIER = /^[A-Za-z_$][\w$]*/;

/** Keywords after which an operand is expected, so that `/` starts a regular expression rather than a division. */
const BEFORE_OPERAND = new Set([
  'await',
  'case',
  'delete',
  'do',
  'else',
  'in',
  'instanceof',
  'new',
  'of',
  'return',
  'throw',
  'typeof',
  'void',
  'yield',
]);

export function tokenize(source: string, options: TokenizeOptions = {}): Token[] {
  const jsx = options.jsx === true;
  const tokens: Token[] = [];

  /**
   * Scans code from `from` to the end of the source or, when `nested`, to the `}` that closes the template
   * substitution or JSX expression the code sits in. Returns the offset just past where it stopped. Only top-level
   * code emits tokens; nested code is part of the template literal or JSX element around it.
   */
  const code = (from: number, nested: boolean): number => {
    let i = from;
    let braces = 0;
    let operand = true;
    let last: Token | undefined;
    const emit = (kind: TokenKind, end: number): void => {
      const token: Token = { kind, start: i, end, text: source.slice(i, end) };
      if (!nested) tokens.push(token);
      if (kind !== 'comment') {
        operand = expectsOperand(token, last, operand);
        last = token;
      }
      i = end;
    };

    if (i === 0 && source.startsWith('#!')) emit('comment', lineEnd(source, 0));
    while (i < source.length) {
      const char = source.charAt(i);
      const next = source.charAt(i + 1);
      if (WHITESPACE.test(char)) {
        i++;
      } else if (char === '/' && next === '/') {
        emit('comment', lineEnd(source, i));
      } else if (char === '/' && next === '*') {
        const close = source.indexOf('*/', i + 2);
        emit('comment', close < 0 ? source.length : close + 2);
      } else if (char === "'" || char === '"') {
        emit('string', stringEnd(source, i));
      } else if (char === '`') {
        emit('template', templateEnd(i + 1));
      } else if (char === '/' && operand) {
        emit('regex', regexEnd(source, i));
      } else if (char === '<' && jsx && operand && opensJsx(source, i)) {
        const end = jsxEnd(i);
        if (end < 0) emit('punct', i + 1);
        else emit('jsx', end);
      } else if (DIGIT.test(char) || (char === '.' && DIGIT.test(next))) {
        emit('number', scanWhile(source, i + 1, NUMBER_PART));
      } else if (WORD_START.test(char)) {
        emit('word', scanWhile(source, i + 1, WORD_PART));
      } else {
        if (char === '{') {
          braces++;
        } else if (char === '}') {
          if (nested && braces === 0) return i + 1;
          braces--;
        }
        emit('punct', (char === '+' || char === '-') && next === char ? i + 2 : i + 1);
      }
    }
    return source.length;
  };

  /** Scans a template literal from just after its opening backtick; returns the offset just past its closing one. */
  const templateEnd = (from: number): number => {
    for (let j = from; j < source.length; j++) {
      const char = source[j];
      if (char === '\\') j++;
      else if (char === '`') return j + 1;
      else if (char === '$' && source[j + 1] === '{') j = code(j + 2, true) - 1;
    }
    return source.length;
  };

  /** Scans the JSX element or fragment whose `<` is at `start`; returns the offset just past it, or -1 if unclosed. */
  const jsxEnd = (start: number): number => {
    let j = start + 1;
    // The opening tag, up to `>` or, for a self-closing element, `/>`.
    for (;;) {
      if (j >= source.length) return -1;
      const char = source[j];
      if (char === '/' && source[j + 1] === '>') return j + 2;
      if (char === '>') break;
      if (char === '"' || char === "'") {
        // JSX attribute strings have no escapes and may span lines.
        const close = source.indexOf(char, j + 1);
        if (close < 0) return -1;
        j = close + 1;
      } else if (char === '{') {
        j = code(j + 1, true);
      } else if (char === '<') {
        const end = jsxEnd(j);
        if (end < 0) return -1;
        j = end;
      } else {
        j++;
      }
    }
    // The children, up to the closing tag. In JSX text, `<` and `{` are the only characters with a meaning.
    for (j++; ;) {
      if (j >= source.length) return -1;
      const char = source[j];
      if (char === '{') {
        j = code(j + 1, true);
      } else if (char === '<' && source[j + 1] === '/') {
        const close = source.indexOf('>', j);
        return close < 0 ? -1 : close + 1;
      } else if (char === '<') {
        const end = jsxEnd(j);
        if (end < 0) return -1;
        j = end;
      } else {
        j++;
      }
    }
  };

  code(0, false);
  return tokens;
}

/** Offsets at which each line starts. Line breaks are counted the way tsc counts them. */
export function lineStarts(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === '\r') {
      if (source[i + 1] === '\n') i++;
      starts.push(i + 1);
    } else if (char === '\n' || char === '\u2028' || char === '\u2029') {
      starts.push(i + 1);
    }
  }
  return starts;
}

/** 1-based line of `offset`, given the result of `lineStarts`. */
export function lineAt(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (starts[middle]! <= offset) low = middle;
    else high = middle - 1;
  }
  return low + 1;
}

export function isWord(token: Token | undefined, text: string): boolean {
  return token?.kind === 'word' && token.text === text;
}

export function isPunct(token: Token | undefined, text: string): boolean {
  return token?.kind === 'punct' && token.text === text;
}

/** Whether a line break lies between two offsets. */
export function hasLineBreak(source: string, from: number, to: number): boolean {
  return LINE_BREAK.test(source.slice(from, to));
}

/** Whether an operand is expected after `token`, given the token before it and whether one was expected before it. */
function expectsOperand(token: Token, previous: Token | undefined, before: boolean): boolean {
  switch (token.kind) {
    case 'word':
      // A keyword right after `.` is a property name, which completes an operand like any other name.
      return BEFORE_OPERAND.has(token.text) && !isPunct(previous, '.');
    case 'punct':
      // After an operand, `!`, `++` and `--` are postfix and complete it; before one, they are prefix and still
      // expect it. Either way, the expectation stays as it was.
      if (token.text === '!' || token.text === '++' || token.text === '--') return before;
      // `}` usually closes a block, after which an expression statement may start with a regular expression.
      return token.text !== ')' && token.text !== ']';
    default:
      return false;
  }
}

/**
 * Whether the `<` at `start`, where an operand is expected, opens a JSX element rather than the type parameters of a
 * generic function or function type. Those contain `,`, `extends` or `=`, or are followed by `(`, which an opening
 * tag never is. In type positions this keeps `<T>(value: T) => T` from being read as JSX; in expressions, TypeScript
 * itself reads `<T>(` as JSX, but JSX text starting with `(` is rare.
 */
function opensJsx(source: string, start: number): boolean {
  let j = start + 1;
  if (source[j] === '>') return true;
  const name = JSX_NAME.exec(source.slice(j, j + 256))?.[0];
  if (name === undefined) return false;
  j = skipWhitespace(source, j + name.length);
  if (name === 'const' && IDENTIFIER.test(source.slice(j, j + 256))) return false;
  const char = source[j];
  if (char === '>') return source[skipWhitespace(source, j + 1)] !== '(';
  if (char === '/') return source[j + 1] === '>';
  if (char === '{') return true;
  const attribute = IDENTIFIER.exec(source.slice(j, j + 256))?.[0];
  return attribute !== undefined && attribute !== 'extends';
}

function skipWhitespace(source: string, from: number): number {
  return scanWhile(source, from, WHITESPACE);
}

function lineEnd(source: string, from: number): number {
  return scanWhile(source, from, /[^\n\r\u2028\u2029]/);
}

function scanWhile(source: string, from: number, pattern: RegExp): number {
  let end = from;
  while (end < source.length && pattern.test(source.charAt(end))) end++;
  return end;
}

function stringEnd(source: string, start: number): number {
  const quote = source[start];
  for (let j = start + 1; j < source.length; j++) {
    const char = source[j];
    if (char === '\\') {
      j += source.startsWith('\r\n', j + 1) ? 2 : 1;
    } else if (char === quote) {
      return j + 1;
    } else if (char === '\n' || char === '\r') {
      return j;
    }
  }
  return source.length;
}

function regexEnd(source: string, start: number): number {
  let inClass = false;
  for (let j = start + 1; j < source.length; j++) {
    const char = source.charAt(j);
    if (LINE_BREAK.test(char)) return j;
    if (char === '\\') {
      if (LINE_BREAK.test(source.charAt(j + 1))) return j + 1;
      j++;
    } else if (inClass) {
      if (char === ']') inClass = false;
    } else if (char === '[') {
      inClass = true;
    } else if (char === '/') {
      return scanWhile(source, j + 1, WORD_PART);
    }
  }
  return source.length;
}
