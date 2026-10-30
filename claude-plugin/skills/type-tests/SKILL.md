---
name: type-tests
description: Write and fix verso in-source type tests. Use when you add or change an exported function or generic type alias in a TypeScript package that uses verso (it has `verso-ts` in package.json or a `verso.env.d.ts`), when the verso hook or `verso` reports failing blocks or exports without a block, and when converting `expectTypeOf` tests to verso.
---

# Type tests with verso

verso keeps type tests in the source file, right after the code they test, in `// @verso` blocks. The blocks are
types only, so they cost nothing at runtime, and `npx verso` type-checks the package and reports each block by name.

## When

- Every exported function and generic type alias that you add, or whose signature you change, gets a block in the
  same file, right after its declaration. Update an existing block when you change the signature it pins down on
  purpose.
- Before you finish, run `npx verso` in the package and fix what it reports.

## Find the package's helpers first

1. Find the package's `verso.env.d.ts` and the helper file next to it, usually `verso.ts`. Blocks import `Expect`
   and the other helpers from that helper file, never from `verso-ts` itself: its `Expect` carries the package's key.
2. Import it the way the package imports its other modules: same relative style, with or without the `.ts`
   extension.
3. No helper file yet: run `npx verso init` in the package. Pass `--standalone` when the package's sources may only
   import relative paths, and `--dir` to put both files where the package's conventions allow (for example an
   internal folder, if every file in `src` must be exported or tested).

## Block format

```ts
import type { Equal, Expect } from './verso.ts';

export function chunk<T>(array: readonly T[], size: number): T[][] {
  // ...
}

// @verso chunk
declare type _chunk = [
  Expect<Equal<Parameters<typeof chunk<number>>, [readonly number[], number]>>,
  Expect<Equal<ReturnType<typeof chunk<string>>, string[][]>>,
];
```

- `// @verso <name>` stands on its own line. Name the block after the export it tests; names are unique per file.
- Then `declare type _<name> = [ ... ];`: `declare`, a leading `_`, never `export`, and the body is one tuple.
- The tuple holds `Expect<...>` assertions only.
- Import the helpers with a whole-statement `import type`.
- Negative assertions use `Expect<NotEqual<A, B>>` or `Expect<NotExtends<A, B>>`. Never put `// @ts-expect-error`
  above an `Expect`: where a consumer compiles the source, `Expect` is switched off and the directive breaks the
  consumer's build.

## What to assert

Assert the contract a caller relies on, the way a reviewer would read the signature.

- **Parameters**: `Expect<Equal<Parameters<typeof f>, [string, number?]>>`. Parameter names do not matter.
- **Return type**: `Expect<Equal<ReturnType<typeof f>, string | undefined>>`, and for an async function
  `Awaited<ReturnType<typeof f>>`.
- **Generic function**: a block cannot call `f(...)`, so instantiate it with the type arguments a call would infer:
  `ReturnType<typeof f<number>>`. Without type arguments, `Parameters<typeof f>` shows each type parameter as its
  constraint, which pins a constraint such as `Record<string, unknown>`. A parameter typed as the bare type parameter
  only echoes the type argument once instantiated, so asserting it adds nothing.
- **Mapped keys**: when the result maps over the input's keys (`{ [K in keyof T]: ... }`), also instantiate with an
  optional and a readonly key, such as `typeof f<{ a?: Promise<number>; readonly b: string }>`, so that the block
  fails if the mapping stops keeping `?` and `readonly`.
- **Type guard**: `Expect<Equal<GuardOf<typeof isUser>, User>>`.
- **Overloads**: `Parameters` and `ReturnType` see the last overload only. Pin the whole set, in declaration order:
  `Expect<Equal<typeof f, { (a: string): string | undefined; (a: string, b: number): string }>>`. One `Extends` per
  overload is not enough: it still passes when an overload's return type loses its `| undefined`.
- **Generic type alias**: `Expect<Equal<Path<{ a: { b: 1 } }>, 'a' | 'a.b'>>`, with inputs that reach each branch of
  the type.

Helpers: `Equal` (identical types), `NotEqual`, `Extends` (assignable), `NotExtends`, `GuardOf` (the narrowed type
of a type guard). Prefer `Equal`: it already fails when `| undefined` goes missing, a literal widens or `readonly`
drops. Use `Extends` only when assignability really is the contract, and `NotEqual` or `NotExtends` only where no
`Equal` pins the type, such as beside an `Extends`. An assertion that can only fail together with another one adds
nothing: a `NotEqual` next to an `Equal` on the same type is one.

Converting an `expectTypeOf` test keeps its intent: `expectTypeOf(chunk([1, 2], 1)).toEqualTypeOf<number[][]>()`
becomes `Expect<Equal<ReturnType<typeof chunk<number>>, number[][]>>`, and `expectTypeOf(isDate).guards` becomes
`GuardOf<typeof isDate>`.

## Run and fix

Run `npx verso` from the package directory (`npx verso --json` gives the same result as JSON, with an `uncovered`
list of exports that no block mentions). A failing assertion prints its `{ actual; expected }`:

- If the expected type was wrong, correct the assertion.
- If the implementation's type is wrong, correct the implementation.
- Never weaken an assertion to make it pass: no switching `Equal` to `Extends`, no `any`, no deleting it.

verso also reports misplaced or malformed blocks as problems; fix those as the message says.
