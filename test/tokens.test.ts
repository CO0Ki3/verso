import { describe, expect, it } from 'vitest';

import { lineAt, lineStarts, tokenize, type TokenKind } from '../src/tokens.ts';

const kinds = (source: string, jsx = false): [TokenKind, string][] =>
  tokenize(source, { jsx }).map((token) => [token.kind, token.text]);

/** The texts of the comments the tokenizer found, which is where markers would be. */
const comments = (source: string, jsx = false): string[] =>
  kinds(source, jsx)
    .filter(([kind]) => kind === 'comment')
    .map(([, text]) => text);

describe('tokenize', () => {
  it('keeps comments, strings and code apart', () => {
    expect(kinds(`const a = '// @verso x'; // real\n/* // @verso y */ b`)).toEqual([
      ['word', 'const'],
      ['word', 'a'],
      ['punct', '='],
      ['string', "'// @verso x'"],
      ['punct', ';'],
      ['comment', '// real'],
      ['comment', '/* // @verso y */'],
      ['word', 'b'],
    ]);
  });

  it('reads a template literal as one token, substitutions and nested templates included', () => {
    expect(kinds('`a${ {b: `c${d}`} }e`; x')).toEqual([
      ['template', '`a${ {b: `c${d}`} }e`'],
      ['punct', ';'],
      ['word', 'x'],
    ]);
    expect(kinds('`\n// @verso fake\n`; x')).toEqual([
      ['template', '`\n// @verso fake\n`'],
      ['punct', ';'],
      ['word', 'x'],
    ]);
  });

  it('tells regular expressions from divisions by whether an operand is expected', () => {
    expect(kinds('a / b / c')).toEqual([
      ['word', 'a'],
      ['punct', '/'],
      ['word', 'b'],
      ['punct', '/'],
      ['word', 'c'],
    ]);
    expect(kinds(`x = /['"\`]/g; return /a\\/[/]b/i`)).toEqual([
      ['word', 'x'],
      ['punct', '='],
      ['regex', `/['"\`]/g`],
      ['punct', ';'],
      ['word', 'return'],
      ['regex', '/a\\/[/]b/i'],
    ]);
    expect(kinds('(a) / 2')).toEqual([
      ['punct', '('],
      ['word', 'a'],
      ['punct', ')'],
      ['punct', '/'],
      ['number', '2'],
    ]);
  });

  it('reads `!`, `++` and `--` as postfix after an operand and as prefix before one', () => {
    expect(kinds('a! / 2; i++ / 2; j-- / 2').filter(([kind]) => kind === 'regex')).toEqual([]);
    expect(kinds('x = !/a/.test(s); y = ++/b/.lastIndex').filter(([kind]) => kind === 'regex')).toEqual([
      ['regex', '/a/'],
      ['regex', '/b/'],
    ]);
  });

  it('reads a keyword after `.` as a property name', () => {
    expect(kinds('s.in / s.out; t.new / 2').filter(([kind]) => kind === 'regex')).toEqual([]);
    expect(kinds('x in /a/')).toContainEqual(['regex', '/a/']);
  });

  it('finds markers after divisions inside template substitutions', () => {
    const source = [
      'function f(s: { in: number; out: number }, a: number[], i: number) {',
      '  return `${s.in / s.out} ${a[0]! / 2} ${i++ / 2} ${s.new / 3}`;',
      '}',
      '// @verso after',
    ].join('\n');
    expect(comments(source)).toEqual(['// @verso after']);
  });

  it('ends an unterminated string at the line break', () => {
    expect(kinds(`<p>Don't</p>\n// @verso real`)).toContainEqual(['comment', '// @verso real']);
  });

  it('reads a hashbang as a comment', () => {
    expect(kinds('#!/usr/bin/env node\nx')).toEqual([
      ['comment', '#!/usr/bin/env node'],
      ['word', 'x'],
    ]);
  });

  it('escapes in strings and templates do not end them', () => {
    expect(kinds(`'a\\'b' "c\\"d" \`e\\\`f\``)).toEqual([
      ['string', "'a\\'b'"],
      ['string', '"c\\"d"'],
      ['template', '`e\\`f`'],
    ]);
  });

  it('counts `++` and `--` as one token each', () => {
    expect(kinds('++i - --j')).toEqual([
      ['punct', '++'],
      ['word', 'i'],
      ['punct', '-'],
      ['punct', '--'],
      ['word', 'j'],
    ]);
  });
});

describe('tokenize with jsx', () => {
  it('reads a JSX element as one token, so its text cannot open comments, strings or templates', () => {
    const source = [
      'export function Upload() {',
      "  return <p>Accepts image/*, video/mp4. Don't press ` here // or here</p>;",
      '}',
      '// @verso after',
    ].join('\n');
    expect(kinds(source, true)).toContainEqual([
      'jsx',
      "<p>Accepts image/*, video/mp4. Don't press ` here // or here</p>",
    ]);
    expect(comments(source, true)).toEqual(['// @verso after']);
  });

  it('reads attributes, expressions, nested elements and fragments', () => {
    const element = `<ul className="a>b" {...rest} title={'}'}>{items.map((item) => <li key={item}>{item}</li>)}<br /></ul>`;
    expect(kinds(`const list = ${element};`, true)).toEqual([
      ['word', 'const'],
      ['word', 'list'],
      ['punct', '='],
      ['jsx', element],
      ['punct', ';'],
    ]);
    expect(kinds('cond ? <A /> : <></>', true)).toEqual([
      ['word', 'cond'],
      ['punct', '?'],
      ['jsx', '<A />'],
      ['punct', ':'],
      ['jsx', '<></>'],
    ]);
  });

  it('does not take type parameters, comparisons or type arguments for JSX', () => {
    const source = [
      'const f = <T,>(value: T) => value;',
      'const g = <T extends object>(value: T) => value;',
      'const h = <const T,>(value: T) => value;',
      'type F = <T>(value: T) => T;',
      'type G = Array<<T>() => T>;',
      'const less = a < b;',
      'const call = f<string>(x);',
    ].join('\n');
    expect(kinds(source, true).filter(([kind]) => kind === 'jsx')).toEqual([]);
  });

  it('reads an element whose closing tag never comes as a plain `<`', () => {
    expect(comments('const broken = <div>unclosed\n// @verso after', true)).toEqual(['// @verso after']);
  });

  it('reads no JSX without the option', () => {
    expect(kinds('x = <div>a</div>').filter(([kind]) => kind === 'jsx')).toEqual([]);
  });
});

describe('lineStarts and lineAt', () => {
  it('counts every line break tsc counts', () => {
    const source = ['a', 'b', 'c', 'd', 'e'].join('\n').replace('b\n', 'b\r\n').replace('c\n', 'c\r');
    const separated = source.replace('d\n', `d${String.fromCharCode(0x2028)}`);
    const starts = lineStarts(separated);
    expect(starts).toHaveLength(5);
    expect([...'abcde'].map((letter) => lineAt(starts, separated.indexOf(letter)))).toEqual([1, 2, 3, 4, 5]);
  });

  it('maps offsets on a line break to the line it ends', () => {
    const starts = lineStarts('ab\ncd');
    expect(lineAt(starts, 2)).toBe(1);
    expect(lineAt(starts, 3)).toBe(2);
    expect(lineAt(starts, 5)).toBe(2);
  });
});
