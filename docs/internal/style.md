# Style Guide

Conventions for the suss codebase. Enforced by Biome (`biome.json`) and TypeScript strict mode (`tsconfig.base.json`). Pre-commit hook (husky + lint-staged) runs `biome check --write` on staged files.

## Tooling

- **Biome 2.x** is the only formatter/linter. No ESLint, no Prettier.
- **TypeScript strict mode** with `exactOptionalPropertyTypes` and `strictNullChecks`.
- Run `npm run lint` / `npm run lint:fix` / `npm run format` at the root.

## Formatting

- 2-space indent, LF line endings, semicolons always, trailing commas everywhere
- Double quotes for strings, double quotes for JSX attributes
- Arrow functions always wrap params in parens: `(x) => x + 1`, not `x => x + 1`
- Bracket spacing in objects: `{ foo }` not `{foo}`

## Imports

Biome auto-organizes imports into these groups (blank line between each):
1. Node built-ins (`node:fs`, `node:path`)
2. External packages (`ts-morph`, `vitest`)
3. Internal packages (`@suss/*`)
4. Aliases (none in suss today, reserved)
5. Relative paths
6. Type-only imports (use `import type { ... }`)

Prefer `import type` for type-only imports: Biome enforces this and it keeps runtime imports small.

## TypeScript

- Discriminated unions use `type` as the discriminant field, consistently. Never `kind`, never `style`.
- Prefer discriminated unions over loose interfaces with optional fields. A `{ type: "X"; requiredField: string }` variant is better than `{ type: "X"; requiredField?: string }` with documentation.
- **DispatchTable over `switch`.** For dispatch on a discriminated union, use a `Record` keyed by the discriminant (e.g. `const handlers: Record<Event["type"], Handler> = { created, deleted, … }`) rather than a `switch` statement. We call this the *DispatchTable* pattern; it makes exhaustiveness a type error when a new variant lands, and keeps each handler a named, independently testable function.
- `as const` for literal narrowing when necessary, but prefer proper typing at the declaration site.
- Avoid `any`. Use `unknown` for data whose shape you don't know and narrow at the boundary.
- Avoid type assertions (`as X`) unless you've exhausted type narrowing. If you need them, comment why.
- `noInferrableTypes` is on: don't annotate types the compiler infers on its own (`const x: number = 5` → `const x = 5`).
- `exactOptionalPropertyTypes` is on: do not assign `undefined` explicitly to optional properties. Either omit the key (use conditional spread `...(cond ? { key: val } : {})`) or type the field as `T | undefined` if `undefined` is a meaningful value.

## Code style

- Arrow functions for most values (`export const foo = () => ...`); top-level `export function foo() {}` is also fine.
- No `else` after `return`/`throw` (`noUselessElse`).
- Single variable per declaration (`useSingleVarDeclarator`).
- Block statements for all control flow (`useBlockStatements`): no single-line `if (x) return;`.
- Use `Number.parseInt` / `Number.isNaN` etc. (`useNumberNamespace`) instead of the globals.
- `noUnusedImports` and `noUnusedVariables` are errors: remove unused code as you go.
- **Object arguments for 4+ params.** Functions that take four or more parameters should accept a single options object so call sites are self-documenting. `extractStatusCode({ extraction, exceptionType, calls })` beats `extractStatusCode(extraction, null, null, calls, null)`. Three-or-fewer params is fine positional when the order follows a standard pattern (input → filter → label, left → op → right). Callback-style functions (`map`, reducers) are exempt: they have a conventional positional contract.
- **No if-else chains assigning to a variable.** `let x; if (...) { x = a } else if (...) { x = b } else { x = c }` is a code smell: extract a helper function that returns the value directly per branch. The assign-in-branches shape hides the "one of several results" intent, loses per-branch type narrowing, and makes `x` mutable for no reason. This complements the DispatchTable rule above: DispatchTable for discriminated-union dispatch, early-return helpers for everything else (boolean conditions, string-compare chains, heterogeneous predicates). Two-branch cases that reduce to a ternary are fine to leave inline.

## Identifiers a pack names

A pack may hardcode an identifier only when the library that pack is about defines it. Anything a specific codebase names goes in per-project configuration, through the pack's options and `-f <pack>=config.json`.

Two things go wrong when a project's name ships as a default. Every other user gets false matches, because any class called `WidgetController` or any function called `makeWidgetHandler` matches whatever it actually does. And coverage measured against the codebase the name came from is inflated, because discovery found those units by name rather than by pattern.

Each pack declares its vocabulary in `vocabulary.json` at the package root: every identifier the pack's shipped source names, mapped to where in the library it comes from. `npm run check:vocabulary` fails when a pack names something that file does not declare, so a reviewer sees the claim in the diff. Names suss itself defines (IR kinds, roles, grammar tags) live once in `packages/extractor/vocabulary.json`. A name a project supplies through pack config never appears as a literal in the pack's source, so only the shipped defaults are policed.

The language adapters answer to the same check inverted: an adapter's shipped source may not contain a string literal that a pack's vocabulary declares as its library's own name, because the adapter owns language syntax and scoping while every library-defined name reaches it through a typed pack field. Each adapter is matched against the framework packs that declare a dependency on it.

## Naming

A name should say what the thing is for, so someone who has never opened the file can guess what it does before reading it.

**Packages** take the job they do. When several packages do the same job against different targets, the family comes first in the name: `@suss/framework-hono` reads Hono apps, `@suss/client-axios` reads axios call sites, `@suss/contract-openapi` reads OpenAPI documents, `@suss/runtime-node` reads what the Node runtime exposes. A package with no siblings takes a bare noun: `@suss/checker`, `@suss/extractor`, `@suss/resolution`.

Two packages break this. `@suss/datalog` and `@suss/differential` are named for the technique they use rather than the job they do. Both predate the convention and keep their names; don't take them as the pattern for a new package.

**Directories under `packages/`** spell out the package name minus the `@suss/` scope. `@suss/behavioral-ir` lives in `packages/behavioral-ir`, and `@suss/checker` lives in `packages/checker`. A family prefix becomes the parent directory, so `@suss/framework-hono` lives in `packages/framework/hono`. Someone following an import should be able to find the directory by reading the package name.

**Datalog relations** read as a sentence about a single fact, verb first, stating what is true. `binds(x, y)` says the name `x` is declared as `y`. `holdsProperty(o, n, x)` says object `o` holds `x` under the name `n`. `comesTo(x, z)` says following the name `x` arrives at `z`. Avoid relation names that sound like an instruction to the engine (`resolveBinding`, `doLookup`); a rule states a fact, and the engine decides when to derive it.

**Functions** are named for the answer they give back. `routePathFromFile` gives the route path a file maps to. `returnPositionOf` gives the position a node returns from. `providersOf` gives the providers of a boundary. Predicates read as the question the caller is asking: `isGrouping`, `startsItsOwnScope`. Skip `get`, `compute`, and `handle` prefixes on new names, since they describe the machinery instead of the answer.

**Concepts** are plain English, one word, drawn from the vocabulary already in the codebase: boundary, summary, gap, terminal, transition, pack. Before naming a new concept, grep for how the code already talks about it. A second word for an idea that already has one costs every later reader a lookup.

## Comments and docs

- JSDoc on exported functions and types when the name isn't self-explanatory.
- No comments for what the code does; comments explain *why* or call out non-obvious behavior.
- `// TODO:` is fine for deferred work; link to a tracking issue if it exists.

## Tests

- Vitest. Each package has its own `vitest.config.ts` and one or more `*.test.ts` files next to the source.
- Test file naming: `index.test.ts` next to `index.ts`. One test file per source file is typical but not required.
- Prefer hand-crafted data fixtures over file-based fixtures when the data is small enough to read in one screen; it's easier to understand and update.
- Tests describe *behavior*, not implementation: `it("wraps null-structured conditions as opaque")` not `it("assembleSummary works")`.
- A test that parses fixture source takes its ts-morph project from `@suss/test-project`, so every test reads the same language the adapter reads. `createTestProject()` gives what suss configures for a codebase with no tsconfig; `createStrictTestProject()` gives what a codebase whose tsconfig turns strictness on gets, and only a test about nullability needs it. Both hand back a project reused between calls with everything the last caller wrote removed, so hold onto yours only until the next call. A test reading fixture files off disk builds its own project with `testCompilerOptions`.

## Commits

Follow [Conventional Commits](https://www.conventionalcommits.org/). Format:

```
<type>(<scope>): <short summary>

<optional body; explain why, not what>
```

**Types:** `feat`, `fix`, `docs`, `test`, `chore`, `refactor`, `perf`

**Scopes** (optional but encouraged in a monorepo): the affected package name, e.g. `ir`, `adapter`, `extractor`, `checker`, `cli`, any framework pack (`ts-rest`, `express`, `fastify`, `react`, `react-router`, `apollo`, …), any runtime pack (`axios`, `web`, `apollo-client`), any stub source (`openapi`, `cloudformation`, `storybook`, `appsync`, …), or `docs` / `scripts` when the change lives outside packages. This list is illustrative, not exhaustive; use the shortest scope that names what changed, combine with commas when a commit cuts across several, and omit scope entirely for changes that cut across the whole repo.

**Guidelines:**
- Each commit should have a single primary intent. Split mixed changes (e.g. a feature + a doc update + a test fix) into separate commits.
- The summary line describes the change concisely (imperative mood, lowercase, no period).
- Use the body for *why* this change was made, not a restatement of the diff.
- Don't reference internal project management (phase numbers, task IDs, plan steps); commit history is for contributors reading the log, not for tracking internal milestones.

## Monorepo conventions

- All packages are `@suss/<name>`, and the directory spells the name out (see [Naming](#naming)). Category directories such as `packages/framework/` are not themselves packages.
- Internal dependencies use `workspace:*`.
- `turbo build` and `turbo test` are the entry points; don't run package-level scripts directly except for debugging.
