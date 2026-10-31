# @suss/framework-vitest

The pack for vitest tests. It reads each test case as a `test` unit, so
a PRD scenario can say which test covers it and `suss check --intent`
can check that the test is still there, still runs, and still reaches
what the scenario is about.

```ts
import { describe, expect, it, vi } from "vitest";
import { cancelOrder } from "./orders";

describe("cancel", () => {
  it("marks the order cancelled", () => {
    expect(cancelOrder("o-1").status).toBe("cancelled");
  });
});
```

That case becomes a unit named `cancel > marks the order cancelled`,
and a PRD lists it the way the runner prints it, with the file in
front:

```yaml
coveredBy: src/orders.test.ts > cancel > marks the order cancelled
```

A test is no boundary, so its unit pairs with nothing. Its body is read
like any other unit, so its calls are recorded and a reach question can
follow them.

## Usage

Read only the test files your PRDs list:

```bash
suss extract -f vitest -f express --intent intent/ -o .suss/code.json
suss check --dir .suss --intent intent/
```

`--intent` reads the `coveredBy` lines in the PRDs under `intent/` and
hands the pack those files. Without it the pack reads every file that
imports vitest, which can double what an extract walks, so `suss init`
does not suggest the pack. To name the files yourself, write them to a
config file:

```bash
suss extract -f vitest=vitest.json
```

```json
{ "files": ["src/orders.test.ts"] }
```

A file matches on whole path segments from the end, so a repo-relative
path matches a file the run reads from a package directory.

## Tests that use vitest's globals

With `test: { globals: true }` in the config, a test calls `describe`,
`it` and `vi` without importing them:

```ts
// vitest.config.ts
export default defineConfig({ test: { globals: true } });

// src/orders.test.ts
describe("cancel", () => {
  it("marks the order cancelled", () => { ... });
});
```

The pack reads `vitest.config.*`, or `vite.config.*` when there is none,
in the directory the run reads, and turns globals on when the config
writes `globals: true` inside its `test` block. It then reads every file
named like `*.test.*` or `*.spec.*`, whatever the file imports, and
takes a `describe`, `it`, `test` or `vi` the file does not import or
declare itself as vitest's. A file that imports its own `test`, as a
Playwright spec does, is left alone. The pack also reads a config that a
`package.json` script hands vitest with `--config`. Point `config` at
one it would not find, or set `globals` to decide for yourself, for
instance when the config builds its options in a function the pack
cannot read:

```json
{ "config": "tools/vitest.unit.mjs" }
```

```json
{ "globals": true }
```

## What it records

- The case's title path: each `describe` or `suite` title, then the
  `it` or `test` title, joined with ` > `. A title the adapter cannot
  read as a string keeps its source text and is recorded under
  `metadata.test.unresolvedTitle`.
- Whether the case runs. `it.skip`, `it.todo`, and any case under
  `describe.skip` or `describe.todo`, are recorded as
  `metadata.test.skipped`.
- What the test replaces before it runs, under `metadata.test.mocks`:
  `vi.mock` and `vi.doMock` give the module, resolved to a project file
  when the specifier is relative, and `vi.spyOn` gives the member it
  replaces. A mock at module scope applies to every case in the file,
  and one inside a suite or a case applies only there.

The intent check refuses to count a path into a mocked module or a
spied member as reaching the subject, and says which mock was in the
way.

## What this leaves out

- `it.each` and `it.for` declare one case per row. The pack reads the
  case once, under the title as written with its placeholders, and
  records that title as unresolved.
- With globals on, a test file named outside the default pattern, as a
  config that sets `test.include` to something else can arrange.
- A spy on an object's member matches any method of that name, since
  the pack cannot tell which object the spy was on.
