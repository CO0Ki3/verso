# verso

[verso](https://dictionary.cambridge.org/dictionary/english/verso) brings in-source testing to TypeScript's types.

[In-source testing](https://vitest.dev/guide/in-source) keeps tests in the file they test rather than in a separate
test file. Rust made it the convention: unit tests live in a
[`#[cfg(test)] mod tests`](https://doc.rust-lang.org/book/ch11-03-test-organization.html#the-tests-module-and-cfgtest)
block next to the code, where they can reach its private items, and the `cfg(test)` attribute compiles them only for
`cargo test`, so they never reach a regular build. Vitest offers the same for JavaScript with `import.meta.vitest`.

verso carries Rust's notation over to type assertions. A `// @verso <name>` marker plays the part of `#[cfg(test)]`,
and the block under it is an unexported type alias that holds the assertions. Like a Rust test module, the block
leaves no trace in the build: no JavaScript, no declarations, no runtime import. Nor does it ever fail a consumer that
compiles the package's source (see [the gate](#the-gate)). The `verso` command type-checks the project with `tsc` and
reports each block by name, with the actual and expected types of every failing assertion.

```ts
import type { Equal, Expect } from './verso.ts';

export function parseAge(text: string) {
  const age = Number.parseInt(text, 10);
  return Number.isNaN(age) ? undefined : age;
}

// @verso parseAge
declare type _parseAge = [
  Expect<Equal<Parameters<typeof parseAge>, [string]>>,
  Expect<Equal<ReturnType<typeof parseAge>, number | undefined>>,
];
```

If someone later returns `null` instead of `undefined`, the inferred return type changes, and verso says so:

```
$ verso
✗ src/parseAge.ts:8  parseAge
    11:10  TS2344  Type '{ actual: number | null; expected: number | undefined; }' does not satisfy the constraint 'true'.

1 block: 0 passed, 1 failed · 2 assertions
```

A verso is the back of a printed page: part of the same sheet, never what gets published.

## Why in source

In a utility library, a type test usually pins down a function signature: its parameters, its return type, the type
it narrows to. Such tests read best next to the declaration they describe. Runtime tests are a different matter: they
are often several times longer than the code, and keeping them in the source would bury it. Type assertions are
short, and because they are types only, they cost nothing at runtime.

The blocks are ordinary TypeScript, so `tsc` and the editor check them even without verso. What verso adds is a name
for each block, the failing assertions grouped under it, a pass/fail count, and checks that the blocks are set up so
that they actually test something.

## Getting started

```sh
pnpm add -D verso
pnpm verso init
```

`verso init` writes two files into `src` (change it with `--dir`):

- `verso.ts`, the helpers that blocks import. Its `Expect` is gated by the package's key, its name in `package.json`
  unless `--key` says otherwise.
- `verso.env.d.ts`, which enables that key. The tsconfig must include it, and nothing may import it.

A package whose sources may only import relative paths can pass `--standalone`, which copies the helper definitions
into `verso.ts` instead of importing them from `verso`.

Then write blocks and run `verso`. Install verso as a devDependency: none of it runs or ships with the package.

## The gate

A consumer that compiles the package's source, for example through workspace `exports` that point at `src/*.ts`,
also type-checks the blocks in it, under the consumer's compiler options. Options such as
`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, the strict family or a newer `lib` change what types
are, so assertions that hold for the package fail in the consumer, and `skipLibCheck` does not help.

The gate prevents that. The package's `Expect` only accepts `true` when the program enables the package's key, and
only `verso.env.d.ts` enables it. The package's own program includes that file. A consumer's program does not,
because nothing imports it, so there `Expect` accepts anything and the blocks check nothing. Keys are per package, so
a consumer that uses verso itself does not switch on the blocks of the packages it compiles.

Because a shut gate passes everything, verso reports the setups that would shut it by mistake:

- the program has blocks but no `verso.env.d.ts`, for example because the tsconfig does not include it;
- an `Expect` depends on a key that no `verso.env.d.ts` in the program enables, for example because the env file
  gained an `import` or `export`, which makes its interface local to it.

The gate covers the blocks only. A consumer that compiles the source under other options also type-checks the
implementation under them, which no helper can change. Where that matters, let the consumer read the package's
declarations instead, for example through project references.

## Usage

```sh
verso [-p tsconfig.json] [--verbose]
verso init [--dir src] [--key <key>] [--standalone]
```

| Option                 | Meaning                                                                |
| ---------------------- | ---------------------------------------------------------------------- |
| `-p, --project <path>` | `tsconfig.json`, or a directory holding one (default: `tsconfig.json`) |
| `--verbose`            | also list passing blocks and the TypeScript in use                     |
| `--dir <dir>`          | `init`: the directory that receives both files (default: `src`)        |
| `--key <key>`          | `init`: the package's key (default: its name in `package.json`)        |
| `--standalone`         | `init`: copy the helpers instead of importing them from `verso`        |

verso runs the project's own `tsc` once (`--noEmit --listFiles --noErrorTruncation`) and assigns each diagnostic to
the block whose lines it falls on. It scans only the files under the tsconfig's directory, outside `node_modules`.
`typescript` is a peer dependency.

| Exit code | When                                                                                                                          |
| --------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 0         | every block passes                                                                                                            |
| 1         | a block fails or was not checked, verso reports a problem, `tsc` reports an error outside blocks, or there is no block at all |
| 2         | verso cannot run: bad arguments, no tsconfig, no TypeScript, or `tsc` crashed                                                 |

Errors outside blocks fail the run, so verso doubles as the project's type check. Finding no block at all fails too,
because that usually means the wrong tsconfig. When `tsc` finds syntax or compiler option errors, it stops before
type checking; verso then reports the blocks as not checked rather than passed. For the same reason, verso turns off
`noCheck` for its run (TypeScript 5.6 and later) and reports a file with blocks under `// @ts-nocheck`.

## Writing blocks

```ts
// @verso <name>
declare type _alias = [
  Expect<...>,
  Expect<...>,
];
```

- Blocks go in `.ts`, `.mts`, `.cts` and `.tsx` files.
- The marker `// @verso <name>` stands on a line of its own. The name is the rest of the line and must be unique in
  the file.
- The next declaration after the marker is the block; blank lines and comments may come in between. It must be a
  `declare type` alias whose name starts with `_` and whose body is a tuple of `Expect<...>` assertions.
- The block ends at the bracket that closes the tuple. A trailing `;` is optional.
- Negative tests use `NotEqual` and `NotExtends`. verso reports a `// @ts-expect-error` placed right above an
  `Expect`. Where the gate is shut, such an `Expect` no longer fails, so the directive goes unused (TS2578) and breaks
  the consumer. The directive is still fine above other things, such as a type argument that must violate a
  constraint.

Each rule has a reason:

| Rule                 | Why                                                                                                      |
| -------------------- | -------------------------------------------------------------------------------------------------------- |
| `declare type`       | A plain `type` alias that nothing uses fails `noUnusedLocals` (TS6196). Ambient declarations are exempt. |
| Not exported         | An exported alias would end up in the declaration output and in the package's public types.              |
| Name starts with `_` | Unused-variable lint rules skip it: oxlint by default, typescript-eslint with `varsIgnorePattern: '^_'`. |
| Body is one tuple    | Its closing bracket marks the end of the block without relying on semicolons.                            |

verso reports a marker that does not lead to such a declaration as a problem.

## Assertions

| Type                           | Meaning                                                                                                                 |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `Expect<T>`                    | Accepts only `true` (behind the gate). Wrap the other helpers in it.                                                    |
| `Equal<Actual, Expected>`      | `true` when the types are identical, otherwise `{ actual; expected }`, which the error shows.                           |
| `NotEqual<Actual, Expected>`   | `true` when the types differ, otherwise `{ actual; expectedNotEqual }`.                                                 |
| `Extends<Actual, Expected>`    | `true` when `Actual` is assignable to `Expected`, otherwise `{ actual; expectedToExtend }`. Unions are not distributed. |
| `NotExtends<Actual, Expected>` | `true` when `Actual` is not assignable to `Expected`, otherwise `{ actual; expectedNotToExtend }`.                      |
| `GuardOf<F>`                   | The `G` of a type guard `(value) => value is G`, or `never`.                                                            |

Parameters and return types need nothing extra: use `Parameters<typeof f>` and `ReturnType<typeof f>`.

`Equal` applies TypeScript's identity relation, which is stricter than assignability both ways: `any` differs from
every other type, and `{ a: 1 } & { b: 2 }` differs from `{ a: 1; b: 2 }`. It also requires assignability both
ways, which catches the `never[]` that TypeScript infers for an empty array literal; the identity relation alone
takes that type for equal to any array type. And it rebuilds both types from their union members first, so that an
enum compares equal to the union of its members, which the identity relation tells apart.

## What stays out of the build

The JavaScript and declaration output of `tsc` 7 and 5.9, tsdown (with its tsgo, oxc and tsc declaration
generators), rollup-plugin-dts, rolldown, esbuild and Vite library mode contain no block, marker or directive, and
no declaration reachable from the package's entry points references `verso`. Three things to know:

- Import from `verso` with a whole-statement `import type` or `export type`, as `verso init` does. Under
  `verbatimModuleSyntax`, `import { type X } from 'verso'` leaves `import 'verso'` in the JavaScript, which fails
  wherever verso is not installed. verso reports such imports.
- Source maps that embed sources (`sourcesContent`) contain the blocks, like the rest of the source.
- Raw `tsc` emit writes the helper file `verso.ts` as an empty module plus its declarations. Nothing references them.
  Bundlers leave them out.

## Limitations

- `@ts-expect-error` covers the next line only. If a formatter breaks a long assertion over several lines, the
  error moves away from the directive.
- `Parameters` and `ReturnType` see the last overload of an overloaded function only.
- The identity relation behind `Equal` overlooks some differences. A `this` parameter declared on one side only,
  the `const` modifier of a type parameter, `NoInfer`, a method versus a function-valued property, a setter's type
  and the order of an intersection's members do not count, so `Equal<(this: Counter) => void, () => void>` holds.
- An enum and the union of its members compare equal at the top level only. Inside another type, such as
  `{ a: Color }` against `{ a: Color.Red | Color.Green }`, they still differ.
- A solution-style tsconfig (`"files": []` with `references`) checks nothing itself. Run verso on each referenced
  project.
- typescript-eslint does not load with TypeScript 7; it needs the TypeScript 6 compatibility package.

## Compatibility

TypeScript 5.0 to 7.x and Node.js 22 or later. verso only runs `tsc` and reads its output, which is the same on all
of these versions. A few older versions need care:

| TypeScript | Note                                                                                                                                                        |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5.0, 5.1   | `import type ... from './verso.ts'` needs `allowImportingTsExtensions`; import `./verso.js` instead.                                                        |
| up to 5.5  | `emitDeclarationOnly` in the tsconfig conflicts with `--noEmit` (TS5053); point `-p` at a config without it.                                                |
| up to 5.5  | Composite and incremental projects get a `tsconfig.tsbuildinfo` from the run, as with `tsc --noEmit`. From 5.6 on, verso sends it to a temporary directory. |

## Development

```sh
pnpm verso      # check verso's own blocks
pnpm test       # unit tests and end-to-end tests against fixture projects
pnpm check      # all of the above, lint and formatting
pnpm build      # dist/
```
