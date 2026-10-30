import { describe, expect, it } from 'vitest';

import { findExports, mentions } from '../src/exports.ts';

const names = (source: string, jsx = false): string[] =>
  findExports(source, { jsx }).map(({ name, kind }) => `${kind} ${name}`);

describe('findExports', () => {
  it('finds exported function declarations of every kind', () => {
    const source = [
      'export function plain(a: number): number { return a; }',
      'export async function later(): Promise<void> {}',
      'export function* steps() { yield 1; }',
      'export default function named() {}',
      'export declare function ambient(a: string): void;',
    ].join('\n');
    expect(names(source)).toEqual([
      'function plain',
      'function later',
      'function steps',
      'function named',
      'function ambient',
    ]);
  });

  it('finds exported constants whose value is a function', () => {
    const source = [
      'export const arrow = (a: number) => a;',
      'export const typed = (a: number): number => a;',
      'export const generic = <T,>(a: T) => a;',
      'export const single = a => a;',
      'export const expression = function (a: number) { return a; };',
      'export const asynchronous = async (a: number) => a;',
      'export const annotated: (a: number) => number = (a) => a;',
      'export const KB = 1024;',
      'export const grouped = (1 + 2);',
      'export const config = { a: () => 1 };',
    ].join('\n');
    expect(names(source)).toEqual([
      'function arrow',
      'function typed',
      'function generic',
      'function single',
      'function expression',
      'function asynchronous',
      'function annotated',
    ]);
  });

  it('finds generic type aliases, but not plain ones, interfaces, classes or enums', () => {
    const source = [
      'export type Path<T> = keyof T;',
      'export type Nil = null | undefined;',
      'export interface Box<T> { value: T }',
      'export class Thing {}',
      'export enum Color { Red }',
    ].join('\n');
    expect(names(source)).toEqual(['type Path']);
  });

  it('skips re-exports and anything not at the top level', () => {
    const source = [
      "export { chunk } from './chunk';",
      "export * from './array';",
      'export { local as renamed };',
      'declare namespace N { export function inner(): void; }',
      'function outer() { return { export: 1 }; }',
    ].join('\n');
    expect(names(source)).toEqual([]);
  });

  it('lists an overloaded function once, at its first signature', () => {
    const source = [
      'export function pick(a: string): string;',
      'export function pick(a: number): number;',
      'export function pick(a: unknown) { return a; }',
    ].join('\n');
    expect(findExports(source)).toEqual([{ name: 'pick', line: 1, kind: 'function' }]);
  });

  it('reads TSX', () => {
    expect(names('export function Hello() { return <p>image/*</p>; }\nexport const Bye = () => <></>;', true)).toEqual([
      'function Hello',
      'function Bye',
    ]);
  });
});

describe('mentions', () => {
  it('matches whole words only', () => {
    expect(mentions('Expect<Equal<ReturnType<typeof chunk>, number[][]>>', 'chunk')).toBe(true);
    expect(mentions('Expect<Equal<ReturnType<typeof chunked>, number[][]>>', 'chunk')).toBe(false);
    expect(mentions('Expect<Equal<$chunk, 1>>', 'chunk')).toBe(false);
    expect(mentions('Expect<Equal<typeof $, 1>>', '$')).toBe(true);
  });
});
