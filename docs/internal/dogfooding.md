# Dogfooding: suss on suss

What happens when you run suss against its own source. The goal
isn't a shipping report — it's the "sit in the user's chair"
exercise of asking "I have a TypeScript codebase, I want
summaries, what happens?"

This doc captures what worked, what didn't, and what the
experience surfaces about the pack interface. The reproducer
lives in [`scripts/dogfood.mjs`](https://github.com/nimbuscloud-ai/suss/blob/main/scripts/dogfood.mjs); run it
with `node scripts/dogfood.mjs` (after `npm run build`).

## Setup

The script walks every `@suss/*` package and, for each package,
runs the adapter twice:

- **`packageExports`** — produces `library`-kind provider
  summaries for the package's public API (reachable from
  `package.json` entry points, following barrel re-exports
  through `ts-morph`).
- **`packageImport`** — produces `caller`-kind consumer
  summaries for every function in the package that calls into
  another `@suss/*` package.

Both sides land in `<pkg>/dist/suss-summaries.json` — the format
proposed in `docs/behavioral-summary-format.md`'s "Publishing
summaries" section, now shipping output. The consolidated
roll-up (`scripts/dogfood-report.json`) includes a `pairing`
section: `pairSummaries` is run across the union of all
packages, and every matched provider↔consumer edge is recorded
by `fn:<package>::<exportPath>`.

## What the run produces

**87 provider + 79 consumer summaries across 19/19 `@suss/*`
packages. 79 cross-package edges paired.**

Top consumed exports (packages most depended on by others in the
suss monorepo):

| Export | Callers |
|--------|--------:|
| `@suss/adapter-typescript::createTypeScriptAdapter` | 20 |
| `@suss/behavioral-ir::restBinding` | 19 |
| `@suss/behavioral-ir::functionCallBinding` | 10 |
| `@suss/behavioral-ir::graphqlResolverBinding` | 4 |
| `@suss/checker::checkAll` | 4 |
| `@suss/extractor::assembleSummary` | 3 |
| `@suss/behavioral-ir::graphqlOperationBinding` | 2 |
| `@suss/behavioral-ir::safeParseSummaries` | 2 |
| `@suss/checker::applySuppressions` | 2 |

Every edge is a behavioural pair: the provider summary describes
what the called function does (per-branch conditions + outputs);
the consumer summary describes what the enclosing function does
around the call. The checker's existing pairing machinery does
the matching — no new pairing rule, just a new `boundaryKey`
branch for `function-call` semantics with `package` + `exportPath`.

## What the output looks like

### Library provider

`@suss/checker::predicatesMatch` is a fair mid-sized example — a
4-branch dispatch that returns a string literal per branch:

```
@suss/checker::predicatesMatch
  package-exports:@suss/checker library | packages/checker/src/predicates.ts:12

    if  predicateContainsOpaque(a) || predicateContainsOpaque(b)
      -> return "unknown"
    elif  predicateContainsUnresolved(a) || predicateContainsUnresolved(b)
      -> return "unknown"
    elif  a.type !== b.type
      -> return "nomatch"
    else
      -> return "match" | "nomatch"
```

Header reads "package `@suss/checker`, export `predicatesMatch`";
provenance says the `package-exports:@suss/checker` pack produced
a `library`-kind unit rooted at `predicates.ts:12`. Each branch
shows the predicate that decides it and the literal return value
for that path — no opaque conditions.

### Consumer (caller)

`checkDir` from `@suss/cli` consumes `@suss/checker::checkAll`:

```
checkDir → @suss/checker::checkAll
  package-exports:@suss/cli caller | packages/cli/src/check.ts:104

    if  !(fs.existsSync(path.resolve())) || !(fs.statSync(resolved).isDirectory())
      -> throw Error
    elif  fs.readdirSync(resolved).filter().length === 0
      -> throw Error
    else
      -> return { findings, hasErrors, result }
```

Header shape is `caller → target` — `checkDir` is the enclosing
function that contains the call; `@suss/checker::checkAll` is
what it consumes. Its own decision tree has three branches: two
input-validation throws and a happy-path return with the
expected record shape.

### Pairing

When you run the checker across the union of all summaries, that
consumer summary pairs with the provider summary for
`@suss/checker::checkAll` via the key
`fn:@suss/checker::checkAll`. Same machinery the REST checker
has used for HTTP boundaries since day one — the key just comes
from `function-call` semantics instead of `method + path`.

For the full interpretation guide (header shapes, branch
rendering, gap annotations), see [CLI reference: Reading the output](/reference/cli#reading-the-output).

## What this exercises

- **`packageExports` discovery** — resolves `types` / `default` /
  `import` conditions on `exports`, falls back to `types` /
  `main` / `module` when `exports` isn't set, rewrites
  `dist/*.d.ts` → `src/*.ts`, follows barrel re-exports.
- **`packageImport` discovery** — walks named + default imports
  from targeted packages, records bare-identifier call
  expressions, deduplicates by (enclosing function × consumed
  binding).
- **`library` and `caller` `CodeUnitKind`s** — provider /
  consumer sides of the in-process `function-call` boundary.
  Both slot into `BOUNDARY_ROLE` correctly.
- **Per-package contracts** — the generated
  `dist/suss-summaries.json` files now contain both sides
  together; consumers of the published package can run their
  own summaries against the shipped contract via `suss check`.

## What's still out of scope

- **Factory-return follow-through.** `createTypeScriptAdapter()`
  returns an object with `extractAll()` / `extractFromFiles()`.
  Those methods aren't top-level exports so `packageExports`
  doesn't summarise them, and `packageImport` only tracks bare
  calls — `adapter.extractAll()` is a member-call chain that
  falls through the v0 consumer-side matcher. Both together
  would make factory-shaped APIs first-class.
- **Member-call chains.** The dogfood currently misses consumers
  like `adapter.extractAll()` (see above) and `BehavioralSummarySchema.parse()`.
- **Namespace imports.** `import * as X from "pkg"` is not yet
  tracked on the consumer side.
- **Declarative-data packs.** Framework packs (ts-rest, Express,
  Fastify, React, React Router, Apollo) export a single factory
  that returns a `PatternPack` data structure. Their public API
  is structurally small — one summary per pack, trivially
  bodied. That's correct: a pack is data, not behaviour. The
  19/19 coverage counts them as analysed, not as substantive.

## The in-process API still feels clean

Two discovery variants in one pack, fed into the adapter, out
comes paired provider/consumer summaries — the same properties
the original three-experiment dogfood highlighted. The one
remaining friction: `PatternPack` still requires `languages` /
`terminals` / `inputMapping` even for packs that don't care
about several of them; defaults on the type would reduce the
boilerplate for ad-hoc usage.

## Follow-ups tracked

Not landing in this pass; they go on the backlog:

1. Factory-return follow-through so methods reachable via
   `createX()` / class constructors get their own `library`
   summaries.
2. Member-call chain detection on the consumer side so
   `adapter.extractAll()` pairs with its provider.
3. Namespace imports (`import * as X`) and pattern exports
   (`./utils/*`).
4. Defaults on `PatternPack` to reduce scaffolding friction.
