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

The script walks every `@suss/*` package, builds a `packageExports`
pack pointed at that package's `package.json`, and runs the
adapter against the package's `tsconfig.json`. Each package gets
one summary per reachable public export — root `exports` entry,
sub-path exports (like `@suss/behavioral-ir/schemas`), and
barrel re-exports are all resolved through `ts-morph`'s export
graph.

Per-package summaries land in `<pkg>/dist/suss-summaries.json` (the
format proposed in `docs/behavioral-summary-format.md`'s "Publishing
summaries" section — now shipping output). A consolidated roll-up
lands in `scripts/dogfood-report.json`.

## What the run produces

Current shape: **78 public exports across 19/19 `@suss/*`
packages.** Every package participates — including the thin
"one factory export" framework packs (`apolloFramework`,
`reactFramework`, `expressFramework`, …) whose summaries are
trivially one transition each. The substantial surfaces:

| Package                   | Exports |
|---------------------------|--------:|
| `@suss/checker`           |      21 |
| `@suss/adapter-typescript` |     13 |
| `@suss/behavioral-ir`     |      10 |
| `@suss/cli`               |       8 |
| `@suss/extractor`         |       8 |
| Various stubs / runtimes  |    1–2 each |

Every summary carries a
`function-call { package, exportPath }` binding. Sub-path exports
identify as e.g.
`@suss/behavioral-ir/schemas::BehavioralSummarySchema` —
distinguished from the root-export
`@suss/behavioral-ir::BehavioralSummarySchema` so downstream
consumer-pairing can key by the exact import path.

## What this exercises

- **`packageExports` discovery** — v0 resolver handles
  conditional `exports` (`types` / `default` / `import`), the
  `types`/`main`/`module` fallback, and uniform
  `dist/*.d.ts` → `src/*.ts` rewrites. Pattern exports and
  `development`-conditional resolution are deferred (surface as
  warnings on the resolver result).
- **`library` `CodeUnitKind`** — every emitted summary is
  `kind: "library"`, slotting into `BOUNDARY_ROLE` as
  `"provider"`. The matching consumer kind is deferred.
- **Per-package contracts** — the generated
  `dist/suss-summaries.json` files are exactly what the
  behavioural-summary-format doc proposed shipping next to
  compiled packages. Real provider contracts now exist.

## What's still out of scope

- **Consumer side.** No pack scans `import { fn } from "@suss/…"`
  call sites today. Pairing (checker `boundaryKey` for
  `function-call`) is deferred until the consumer arc lands —
  until then every `library` summary goes into
  `unmatched.providers` at pairing time.
- **Factory-return follow-through.** `createTypeScriptAdapter()`
  returns an object with `extractAll()` / `extractFromFiles()`;
  those methods aren't themselves top-level exports, so
  `packageExports` doesn't currently summarise them. One-level
  return-type follow-through would capture them; adding it
  collides with some of the type-level analysis questions
  tracked on the forward backlog.
- **Declarative-data packs.** The framework packs (ts-rest,
  Express, Fastify, React, React Router, Apollo) export a single
  factory that returns a `PatternPack` data structure. Their
  "public API" is structurally small — one summary per pack,
  trivially bodied. That's correct: a pack is data, not
  behaviour. The 19/19 coverage counts them as analysed, not as
  substantive.

## The in-process API still feels clean

Building the per-package pack inline, constructing the adapter,
calling `extractAll()` reads naturally — the same properties the
original three-experiment dogfood highlighted. The only remaining
friction is that `PatternPack` still requires `languages` /
`terminals` / `inputMapping` even for a pack that doesn't care
about several of them; defaults on the type (or a `partialPack`
builder) would reduce the boilerplate for ad-hoc usage.

## Follow-ups tracked

Not landing in this pass; they go on the backlog:

1. Consumer-side discovery (scan `import { fn } from "pkg"` sites).
   Requires a new `CodeUnitKind` (`caller` or an extension of
   `client`) and a `boundaryKey` rule for `function-call`.
2. Factory-return follow-through for methods reachable via
   `createX()` / class constructors.
3. Broader conditional exports (`development`, pattern
   exports `./utils/*`).
4. Defaults on `PatternPack` to reduce scaffolding friction
   (ergonomic, unchanged from the original dogfood run).
