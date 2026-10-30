// Assertion types for in-source type tests. They are types only, so nothing of them survives in JS output.
// A failing assertion becomes the constraint error of `Expect` (TS2344), and because the failing value is an object
// such as `{ actual; expected }`, the compiler message itself shows what differs.
//
// `Expect` itself is not exported. Each package defines its own, gated by a key that only the package's own program
// enables (see `Gate`), and `verso init` writes it.

declare global {
  /**
   * Keys of the packages whose verso blocks the current program checks. A package's `verso.env.d.ts` adds its key.
   * Nothing imports that file, so a consumer compiling the package's source never has the key.
   */
  interface VersoEnabled {}
}

/**
 * The constraint of a package's `Expect`: `true` when the program enables `Key`, otherwise `unknown`, which accepts
 * anything. Outside the package's own program, such as in a consumer that compiles its source under other compiler
 * options, its assertions therefore check nothing and cannot fail.
 */
export type Gate<Key extends string> = Key extends keyof VersoEnabled ? true : unknown;

/**
 * `true` when both types are identical, otherwise an object holding both.
 *
 * Compares two deferred conditional types, which applies TypeScript's identity relation: stricter than mutual
 * assignability, so `any` differs from every other type and `{ a: 1 } & { b: 2 }` differs from `{ a: 1; b: 2 }`.
 * Mutual assignability is required as well, because the identity relation alone takes the `never[]` inferred for an
 * empty array literal to equal any array type. Both types are first rebuilt from their union members, so that an enum
 * type and the union of its members, which the identity relation tells apart, compare as identical.
 */
export type Equal<Actual, Expected> =
  (<T>() => T extends Members<Actual> ? 1 : 2) extends <T>() => T extends Members<Expected> ? 1 : 2
    ? [Actual, Expected] extends [Expected, Actual]
      ? true
      : { actual: Actual; expected: Expected }
    : { actual: Actual; expected: Expected };

/** `T` rebuilt as a plain union of its members: an enum type becomes the union of its member types. */
type Members<T> = [T] extends [never] ? never : (T extends unknown ? [T] : never) extends [infer U] ? U : never;

/** `true` when the types differ, otherwise an object holding both. The negation of `Equal`. */
export type NotEqual<Actual, Expected> =
  Equal<Actual, Expected> extends true ? { actual: Actual; expectedNotEqual: Expected } : true;

/** `true` when `Actual` is assignable to `Expected`, otherwise an object holding both. Unions are not distributed. */
export type Extends<Actual, Expected> = [Actual] extends [Expected]
  ? true
  : { actual: Actual; expectedToExtend: Expected };

/** `true` when `Actual` is not assignable to `Expected`, otherwise an object holding both. The negation of `Extends`. */
export type NotExtends<Actual, Expected> = [Actual] extends [Expected]
  ? { actual: Actual; expectedNotToExtend: Expected }
  : true;

/** The `G` of a type guard `(value) => value is G`, or `never` when `F` is not a type guard. */
export type GuardOf<F> = F extends (value: any, ...rest: any[]) => value is infer G ? G : never;

// End of the helpers. `verso init --standalone` copies everything above this line; below are verso's own blocks.

/** `Expect` for verso's own blocks, gated by the key that src/verso.env.d.ts enables. */
type Expect<T extends Gate<'verso-ts'>> = T;

// @verso Gate
declare type _Gate = [
  Expect<Equal<Gate<'verso-ts'>, true>>,
  Expect<Equal<Gate<'a package this program does not enable'>, unknown>>,
];

// @verso Equal
declare type _Equal = [
  Expect<Equal<1, 1>>,
  Expect<Equal<string | number, number | string>>,
  Expect<Equal<[value: unknown], [unknown]>>,
  Expect<Equal<any, any>>,
  Expect<Equal<never, never>>,
  Expect<Equal<<T>(value: T) => T, <U>(value: U) => U>>,
  Expect<Equal<Equal<1, 2>, { actual: 1; expected: 2 }>>,
  Expect<NotEqual<any, unknown>>,
  Expect<NotEqual<never, any>>,
  Expect<NotEqual<1, number>>,
  Expect<NotEqual<{ a?: 1 }, { a: 1 | undefined }>>,
  Expect<NotEqual<readonly 1[], 1[]>>,
  // Intersections are not flattened, a documented limitation.
  Expect<NotEqual<{ a: 1 } & { b: 2 }, { a: 1; b: 2 }>>,
];

// @verso NotEqual
declare type _NotEqual = [Expect<NotEqual<1, 2>>, Expect<Equal<NotEqual<1, 1>, { actual: 1; expectedNotEqual: 1 }>>];

// @verso Extends
declare type _Extends = [
  Expect<Extends<1, number>>,
  Expect<Extends<never, 1>>,
  Expect<Extends<{ a: 1; b: 2 }, { a: 1 }>>,
  Expect<Equal<Extends<1 | 'a', number>, { actual: 1 | 'a'; expectedToExtend: number }>>,
];

// @verso NotExtends
declare type _NotExtends = [
  Expect<NotExtends<number, 1>>,
  // A union is checked as a whole, not member by member.
  Expect<NotExtends<1 | 'a', number>>,
  Expect<Equal<NotExtends<1, number>, { actual: 1; expectedNotToExtend: number }>>,
];

// @verso GuardOf
declare type _GuardOf = [
  Expect<Equal<GuardOf<(value: unknown) => value is Date>, Date>>,
  Expect<Equal<GuardOf<(value: unknown, index: number) => value is string>, string>>,
  Expect<Equal<GuardOf<(value: unknown) => boolean>, never>>,
  Expect<Equal<GuardOf<(value: unknown) => asserts value is Date>, never>>,
];
