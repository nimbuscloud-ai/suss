# Style Guide

These are the conventions for the suss codebase. Biome (`biome.json`) and TypeScript strict mode (`tsconfig.base.json`) enforce them. A pre-commit hook (husky + lint-staged) runs `biome check --write` on the files you stage.

## Tooling

- We use **Biome 2.x** as the only formatter and linter. There is no ESLint and no Prettier.
- **TypeScript strict mode** is on, with `exactOptionalPropertyTypes` and `strictNullChecks`.
- Run `npm run lint`, `npm run lint:fix` or `npm run format` at the root.

## Formatting

- Indent with 2 spaces and use LF line endings. Always end statements with semicolons, and put trailing commas everywhere.
- Use double quotes for strings and for JSX attributes.
- Always wrap an arrow function's params in parens: `(x) => x + 1`, not `x => x + 1`.
- Put spaces inside object braces: `{ foo }` not `{foo}`.

## Imports

Biome sorts imports into these groups, with a blank line between each:
1. Node built-ins (`node:fs`, `node:path`)
2. External packages (`ts-morph`, `vitest`)
3. Internal packages (`@suss/*`)
4. Aliases (suss has none today; the group is reserved)
5. Relative paths
6. Type-only imports (use `import type { ... }`)

Use `import type` for an import you only need for types. Biome enforces it, and it keeps the runtime imports small.

## TypeScript

- A discriminated union uses `type` as its discriminant field, every time. Never `kind`, never `style`.
- Prefer a discriminated union to a loose interface with optional fields. A `{ type: "X"; requiredField: string }` variant is better than `{ type: "X"; requiredField?: string }` plus documentation.
- **DispatchTable over `switch`.** To dispatch on a discriminated union, use a `Record` keyed by the discriminant (for example `const handlers: Record<Event["type"], Handler> = { created, deleted, … }`) instead of a `switch` statement. We call this the *DispatchTable* pattern. When someone adds a new variant and forgets a handler, the compiler reports it as a type error. Each handler also stays a named function you can test on its own.
- Use `as const` for literal narrowing when you need it, but prefer typing the value properly where it is declared.
- Avoid `any`. Use `unknown` for data whose structure you don't know, and narrow it where it enters.
- Avoid type assertions (`as X`) until you have run out of ways to narrow. If you need one, add a comment saying why.
- `noInferrableTypes` is on, so don't annotate a type the compiler infers by itself (`const x: number = 5` → `const x = 5`).
- `exactOptionalPropertyTypes` is on, so don't assign `undefined` to an optional property. Either leave the key out (with a conditional spread, `...(cond ? { key: val } : {})`) or type the field as `T | undefined` when `undefined` means something.

## Code style

- Use arrow functions for most values (`export const foo = () => ...`). A top-level `export function foo() {}` is fine too.
- Don't write `else` after `return` or `throw` (`noUselessElse`).
- Declare one variable per statement (`useSingleVarDeclarator`).
- Use block statements for all control flow (`useBlockStatements`), so no single-line `if (x) return;`.
- Use `Number.parseInt`, `Number.isNaN` and the rest of the `Number` namespace (`useNumberNamespace`) instead of the globals.
- `noUnusedImports` and `noUnusedVariables` are errors, so remove unused code as you go.
- **Object arguments for 4+ params.** A function with four or more parameters should take a single options object, so each call site says what its arguments are. `extractStatusCode({ extraction, exceptionType, calls })` is easier to read than `extractStatusCode(extraction, null, null, calls, null)`. Three or fewer positional params are fine when the order follows a familiar pattern, like input → filter → label or left → op → right. Callbacks such as `map` functions and reducers are exempt, because everyone already knows their argument order.
- **No if-else chains assigning to a variable.** Code like `let x; if (...) { x = a } else if (...) { x = b } else { x = c }` should become a helper function that returns the value directly from each branch. Assigning inside the branches hides that you are picking one of several results. You also lose the type narrowing each branch would give you, and `x` ends up mutable for no reason. This goes with the DispatchTable rule above. Use a DispatchTable when you dispatch on a discriminated union, and a helper with early returns for everything else, such as boolean conditions or chains of string comparisons. A two-branch case that fits in a ternary can stay inline.

## Reading a value

Read a value through the evaluator or the resolution store. Don't read it off the syntax at the position you are looking at. What a name was written as, what a template folds to, which function a declaration refers to, and which module an import came from each have one answer per language, computed in one place. A reader written next to the call site only handles the two or three spellings its author had in front of them. It returns null for a constant declared in another file or a path built from a template, and then the caller reports nothing at all. It never reports that it could not read the value.

The entry points in the TypeScript adapter are these:

- `discovery/resolveValue.ts` (`stringValueOf`, `objectLiteralOf`, `propertiesOf`, `propertyValueOf`, `propertyNameOf`, `functionValueOf`, `writtenNodeOf`, `arrayLiteralOf`)
- the `ResolutionStore` in `facts/store.ts` (`resolveWrittenValue`, `resolveObject`, `resolveCallable`, `argumentsPassedTo`, `importedNamesOf`, `importOriginsOf`, `exportsOf`)
- `resolve/functionBehind.ts`, for which function a declaration or an identifier refers to
- `walk/unwrap.ts`, for casts and parentheses
- `discovery/importScan.ts`, for imports
- `values/receiverType.ts` (`receiverTypesOf`), for whether a receiver's type is a library's type. It lists the named types behind a union, an intersection, an alias, a subclass or a type parameter, each with the files that declare it, and the pack tests them. A pack calling `getSymbol()` on the type itself misses all of those.

In the Python and Ruby adapters the entry points are `values/evaluator.ts` (`evaluatedValue`, `stringValueOf`), `facts/resolve.ts` (`writtenValueOf`, `originsOf`) and the literal readers in `ast.ts`. A pack uses what its adapter exports. When the helper a pack needs is not exported, export it from the adapter's index instead of copying it.

Following a declaration's initializer:

```typescript
// Before: finds a function only where it was written out.
const initializer = declaration.getInitializer();
const handler = Node.isArrowFunction(initializer) ? initializer : null;

// After: also finds one bound to a name, imported, or behind a barrel.
const handler = functionValueOf(reference, resolution);
```

Taking a literal off the syntax:

```typescript
// Before: null for `${base}/users`, and for a constant from another file.
const path = Node.isStringLiteral(argument) ? argument.getLiteralValue() : null;

// After: folds the template and follows the constant.
const path = stringValueOf(argument, resolution);
```

When the facility cannot read a spelling, add the case to the facility: a lowering case, a resolution rule, or a store method. A fallback that asks the facility first and then reads the syntax is the same copy with a branch in front of it. `npm run check:readers` scans the adapters and the packs for the textual signs of a second reader. The files that already fail are listed in `EXEMPT` in `scripts/checkReaders.mjs`, each with the functions that do the reading. An entry comes out when its copy goes away.

## Identifiers a pack names

A pack may hardcode an identifier only when the pack's own library defines it. An identifier that comes from one specific codebase goes in per-project configuration instead, which you set through the pack's options and `-f <pack>=config.json`.

Shipping one project's identifier as a default causes two problems. Every other user gets false matches, because any class called `WidgetController` or any function called `makeWidgetHandler` will match whatever it does. And coverage measured on the codebase the identifier came from comes out too high, because discovery found those units by their names instead of by a pattern.

Each pack declares its vocabulary in `vocabulary.json` at the package root. The file lists every identifier that appears in the pack's shipped source and where in the library it comes from. `npm run check:vocabulary` fails when a pack uses an identifier that file does not declare, so a reviewer sees the new identifier in the diff. Identifiers that suss itself defines, such as IR kinds, roles and grammar tags, are declared once in `packages/extractor/vocabulary.json`. An identifier a project supplies through pack config never appears as a literal in the pack's source, so the check only covers the shipped defaults.

The same check runs against the language adapters in the other direction. An adapter's shipped source may not contain a string literal that a pack's vocabulary declares as belonging to its library. The adapter is responsible for language syntax and scoping, and every identifier a library defines reaches it through a typed pack field. Each adapter is checked against the framework packs that declare a dependency on it.

Sometimes a library picks a name the language already uses. SQLAlchemy has `Session.get` and Python has `dict.get`. ActiveRecord has `first` and Ruby has `Array#first`. Start that entry's note with `language:` and say which built-in name it collides with, and the adapter scan skips it. When the adapter spells one of those names it is reading the language, so no library knowledge has leaked into it.

## Both sides of a metadata field

A field on a metadata namespace in `packages/behavioral-ir/src/metadata.ts` has two sides. A contract reader, a pack or an adapter writes it, and a checker pass, `inspect` or `ask` reads it back. The two halves tend to be built weeks apart, each with a test for its own side, and neither test fails while the other side is missing. So a field can ship with a writer, a schema entry and a passing suite, and still change nothing a user sees. `metadata.http.statusRange` is the example to keep in mind. The OpenAPI reader writes the range a `4XX` response covers, and its own test checks the range. No pass has ever compared a consumer branch against a range, so a spec that uses range codes still gets correct branches reported as errors.

`npm run check:metadata-wiring` compares the writers with the readers. It reads the namespaces out of `metadata.ts` and finds each field's writers under `packages/`, outside the packages that read. Then it finds the field's readers under `packages/checker`, `packages/checker-intent` and `packages/cli`, and fails when a field has only one side. Tests and `__fixtures__` count as neither side, since a test on the writing side is exactly what these fields already have. The check also fails when a writer sets a key the schema does not declare, because that key is dropped at read time without an error anywhere.

A field can wait on a consumer nobody has built yet. Put it in `EXEMPT` in `scripts/checkMetadataWiring.mjs` with the reason it is waiting and the issue that tracks the other half.

## Naming

A name should say what the thing is for, so someone who has never opened the file can guess what it does before reading it.

**Packages** are named for the job they do. When several packages do the same job against different targets, the family goes first in the name. `@suss/framework-hono` reads Hono apps, `@suss/client-axios` reads axios call sites, `@suss/contract-openapi` reads OpenAPI documents, and `@suss/runtime-node` reads what the Node runtime exposes. A package with no siblings gets a bare noun, like `@suss/checker`, `@suss/extractor` or `@suss/resolution`.

Two packages break this rule. `@suss/datalog` and `@suss/differential` are named for the technique they use instead of the job they do. Both are older than the convention and keep their names, but don't copy them for a new package.

**Directories under `packages/`** spell out the package name without the `@suss/` scope. `@suss/behavioral-ir` lives in `packages/behavioral-ir`, and `@suss/checker` lives in `packages/checker`. A family prefix becomes the parent directory, so `@suss/framework-hono` lives in `packages/framework/hono`. Someone following an import should be able to find the directory from the package name.

**Datalog relations** read as a sentence about a single fact, verb first, saying what is true. `binds(x, y)` means the name `x` is declared as `y`. `holdsProperty(o, n, x)` means object `o` has `x` under the name `n`. `comesTo(x, z)` means following the name `x` arrives at `z`. Avoid relation names that sound like an instruction to the engine, such as `resolveBinding` or `doLookup`. A rule states a fact, and the engine decides when to derive it.

**Functions** are named for the answer they return. `routePathFromFile` returns the route path a file maps to. `returnPositionOf` returns the position a node returns from. `providersOf` returns the providers of a boundary. A predicate is named after the question the caller is asking, like `isGrouping` or `startsItsOwnScope`. Don't start new names with `get`, `compute` or `handle`, since those describe the machinery instead of the answer.

**Concepts** get plain English names, one word each, taken from the vocabulary the codebase already uses: boundary, summary, gap, terminal, transition, pack. Before you name a new concept, grep for how the code already talks about it. A second word for an idea that already has one means every later reader has to look it up.

## Comments and docs

- Write JSDoc on exported functions and types when the name doesn't explain itself.
- Don't comment on what the code does. Comments explain *why*, or point out behavior a reader would not expect.
- `// TODO:` is fine for deferred work. Link to a tracking issue if there is one.

## Tests

- We test with Vitest. Each package has its own `vitest.config.ts` and one or more `*.test.ts` files next to the source.
- Name a test file after its source file: `index.test.ts` next to `index.ts`. One test file per source file is typical but not required.
- Prefer hand-written data fixtures to file-based fixtures when the data fits on one screen. They are easier to understand and update.
- Tests describe *behavior*, not implementation: `it("wraps null-structured conditions as opaque")` not `it("assembleSummary works")`.
- A test that parses fixture source gets its ts-morph project from `@suss/test-project`, so every test parses the same language the adapter does. `createTestProject()` returns the setup suss uses for a codebase with no tsconfig. `createStrictTestProject()` returns the setup a codebase gets when its tsconfig turns strictness on, and only a test about nullability needs it. Both return a project that is reused between calls, with everything the previous caller wrote deleted, so don't keep a reference to yours past your next call. A test that reads fixture files off disk builds its own project with `testCompilerOptions`.

## Commits

Follow [Conventional Commits](https://www.conventionalcommits.org/). The format is:

```
<type>(<scope>): <short summary>

<optional body; explain why, not what>
```

**Types:** `feat`, `fix`, `docs`, `test`, `chore`, `refactor`, `perf`

**Scopes** are optional but encouraged in a monorepo. Use the affected package name, such as `ir`, `adapter`, `extractor`, `checker` or `cli`, or any framework pack (`ts-rest`, `express`, `fastify`, `react`, `react-router`, `apollo`, …), any runtime pack (`axios`, `web`, `apollo-client`), or any stub source (`openapi`, `cloudformation`, `storybook`, `appsync`, …). Use `docs` or `scripts` when the change is outside packages. These are examples, and other scopes are fine. Pick the shortest scope that says what changed. Join scopes with commas when one commit touches several, and leave the scope off when a change touches the whole repo.

**Guidelines:**
- Give each commit one main intent. Split mixed changes, such as a feature plus a doc update plus a test fix, into separate commits.
- Keep the summary line short: imperative mood, lowercase, no period.
- Use the body to say *why* you made the change. Don't restate the diff.
- Don't refer to internal project management like phase numbers, task IDs or plan steps. Contributors read the commit history to understand the code, and internal milestones mean nothing to them.

## Monorepo conventions

- Every package is `@suss/<name>`, and its directory spells the name out (see [Naming](#naming)). Category directories such as `packages/framework/` are not packages themselves.
- Internal dependencies use `workspace:*`.
- Use `turbo build` and `turbo test`. Don't run package-level scripts directly except when debugging.
