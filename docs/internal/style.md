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

Prefer `import type` for type-only imports — Biome enforces this and it keeps runtime imports small.

## TypeScript

- Discriminated unions use `type` as the discriminant field, consistently. Never `kind`, never `style`.
- Prefer discriminated unions over loose interfaces with optional fields. A `{ type: "X"; requiredField: string }` variant is better than `{ type: "X"; requiredField?: string }` with documentation.
- **DispatchTable over `switch`.** For dispatch on a discriminated union, use a `Record` keyed by the discriminant — e.g. `const handlers: Record<Event["type"], Handler> = { created, deleted, … }` — rather than a `switch` statement. We call this the *DispatchTable* pattern; it makes exhaustiveness a type error when a new variant lands, and keeps each handler a named, independently testable function.
- `as const` for literal narrowing when necessary, but prefer proper typing at the declaration site.
- Avoid `any`. Use `unknown` for genuinely-unknown data and narrow at the boundary.
- Avoid type assertions (`as X`) unless you've exhausted type narrowing. If you need them, comment why.
- `noInferrableTypes` is on — don't annotate types that can be trivially inferred (`const x: number = 5` → `const x = 5`).
- `exactOptionalPropertyTypes` is on — do not assign `undefined` explicitly to optional properties. Either omit the key (use conditional spread `...(cond ? { key: val } : {})`) or type the field as `T | undefined` if `undefined` is a meaningful value.

## Code style

- Arrow functions for most values (`export const foo = () => ...`); top-level `export function foo() {}` is also fine.
- No `else` after `return`/`throw` (`noUselessElse`).
- Single variable per declaration (`useSingleVarDeclarator`).
- Block statements for all control flow (`useBlockStatements`) — no single-line `if (x) return;`.
- Use `Number.parseInt` / `Number.isNaN` etc. (`useNumberNamespace`) instead of the globals.
- `noUnusedImports` and `noUnusedVariables` are errors — clean up as you go.
- **Object arguments for 4+ params.** Functions that take four or more parameters should accept a single options object so call sites are self-documenting. `extractStatusCode({ extraction, exceptionType, calls })` beats `extractStatusCode(extraction, null, null, calls, null)`. Three-or-fewer params is fine positional when the order follows a standard pattern (input → filter → label, left → op → right). Callback-style functions (`map`, reducers) are exempt — they have a conventional positional contract.
- **No if-else chains assigning to a variable.** `let x; if (...) { x = a } else if (...) { x = b } else { x = c }` is a code smell — extract a helper function that returns the value directly per branch. The assign-in-branches shape hides the "one of several results" intent, loses per-branch type narrowing, and makes `x` mutable for no reason. This complements the DispatchTable rule above: DispatchTable for discriminated-union dispatch, early-return helpers for everything else (boolean conditions, string-compare chains, heterogeneous predicates). Two-branch cases that reduce to a ternary are fine to leave inline.

## Comments and docs

- JSDoc on exported functions and types when the name isn't self-explanatory.
- No comments for what the code does; comments explain *why* or call out non-obvious behavior.
- `// TODO:` is fine for deferred work; link to a tracking issue if it exists.

## Tests

- Vitest. Each package has its own `vitest.config.ts` and one or more `*.test.ts` files next to the source.
- Test file naming: `index.test.ts` next to `index.ts`. One test file per source file is typical but not required.
- Prefer hand-crafted data fixtures over file-based fixtures when the data is small enough to read in one screen — it's easier to understand and update.
- Tests describe *behavior*, not implementation: `it("wraps null-structured conditions as opaque")` not `it("assembleSummary works")`.

## Commits

Follow [Conventional Commits](https://www.conventionalcommits.org/). Format:

```
<type>(<scope>): <short summary>

<optional body — explain why, not what>
```

**Types:** `feat`, `fix`, `docs`, `test`, `chore`, `refactor`, `perf`

**Scopes** (optional but encouraged in a monorepo): the affected package name — e.g. `ir`, `adapter`, `extractor`, `checker`, `cli`, any framework pack (`ts-rest`, `express`, `fastify`, `react`, `react-router`, `apollo`, …), any runtime pack (`axios`, `web`, `apollo-client`), any stub source (`openapi`, `cloudformation`, `storybook`, `appsync`, …), or `docs` / `scripts` when the change lives outside packages. This list is illustrative, not exhaustive; use the shortest scope that names what changed, combine with commas when a commit cuts across several, and omit scope entirely for genuinely cross-cutting changes.

**Guidelines:**
- Each commit should have a single primary intent. Split mixed changes (e.g. a feature + a doc update + a test fix) into separate commits.
- The summary line describes the change concisely (imperative mood, lowercase, no period).
- Use the body for *why* this change was made, not a restatement of the diff.
- Don't reference internal project management (phase numbers, task IDs, plan steps) — commit history is for contributors reading the log, not for tracking internal milestones.

## Monorepo conventions

- All packages are `@suss/<name>`. Package directory names are either flat (`packages/ir/`) or nested under a category (`packages/framework/ts-rest/`). Category directories are not themselves packages.
- Internal dependencies use `workspace:*`.
- `turbo build` and `turbo test` are the entry points — don't run package-level scripts directly except for debugging.
