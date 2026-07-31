# Facts and Rules

How extraction's whole-program analyses are structured, for anyone adding or changing one. The short version: they are Datalog rules over a shared fact database, and a strict three-layer boundary keeps them auditable.

## Why rules

Every whole-program analysis in extraction is the same shape underneath: start from some seed facts, apply a step repeatedly, stop when nothing new appears. Reachability, re-throw resolution, and effect propagation are all that shape. Rules state it once, and four properties come with that:

- **Termination is the engine's property.** The evaluator (`@suss/datalog`) runs semi-naive fixpoint iteration. Every analysis written in it terminates by construction, because the fact universe is finite and rules only add.
- **Negation is sound.** Rules are stratified before evaluation, and a cycle through negation is a hard error at evaluation time.
- **The logic is data.** A rule is a plain object you can print, test, and review in isolation. The audit surface is the facts a pass emits and the rules it runs.
- **The analyses become language-independent.** A rule joins fact shapes (`calls`, `entry`, `unitEffect`, and so on), never AST nodes. A second language adapter that emits the same facts gets every analysis for free. This is the concrete mechanism behind "the IR is the product": the facts are a second, lower-level IR.

## The three layers

```
Layer 1: extraction   walks the AST, EMITS FACTS. TypeScript-specific.
Layer 2: rules        derive new facts from facts. No AST, no ts-morph.
Layer 3: assembly     reads derived facts, stamps results onto summaries.
```

The boundary rules, in force now:

1. **Only Layer 1 touches the AST.** A rule never holds a node, a `Project`, or anything from ts-morph. If a rule needs information, Layer 1 emits it as a fact.
2. **One owner per relation.** Each relation name is written by exactly one pass (see the table below). Consumers join against it; they never add to it.
3. **Derived facts land as additive metadata.** Layer 3 stamps results onto summaries (e.g. `metadata.effectsClosure`) without rewriting any transition's own claims. A rules pass can add knowledge; it can never edit extraction's testimony.

## The engine: `@suss/datalog`

Published package, zero dependencies. The API surface is small:

- `Database`: a set of facts, keyed by relation name. `add`, `has`, `facts`, `size`.
- `rule(head, headTerms, body)` with `lit` / `notLit` / `variable` / `constant`: rules as plain data.
- `evaluate(db, rules)`: stratifies, then runs semi-naive fixpoint per stratum. Each round joins only against the facts new in the previous round, so work is proportional to what changed. Negated literals must be fully bound by the positive literals before them.
- `stratify(rules)`: throws on negation cycles ("not stratifiable").

A rule in source looks like this (transitive reachability from the closure pass):

```ts
rule(
  "reachable",
  [variable("callee")],
  [lit("reachable", variable("caller")), lit("calls", variable("caller"), variable("callee"))],
)
```

Read it as: `reachable(callee) :- reachable(caller), calls(caller, callee).`

## The shared fact store

Each `extractAll` run creates **one** fact database and threads it through the passes (`ClosureFacts` in `resolve/boundaryEffects.ts`):

```ts
interface ClosureFacts {
  db: Database;
  unitKeyBySummary: Map<BehavioralSummary, string>;
}
```

- **Unit keys** name functions in fact space: `${filePath}:${startOffset}-${endOffset}`. Offsets rather than line numbers, because offsets are stable under the same parse and unique within a file.
- `unitKeyBySummary` is the bridge between fact space and summary space. Layer 1 registers a summary when it seeds or reaches it; Layer 3 uses the map to find each summary's derived facts.

The reachable-closure pass populates the store as it expands. It is demand-driven: scan the unscanned reachable frontier for call edges, emit `calls` facts, re-evaluate, repeat. That is the lazy variant of pure evaluation, so files that nothing reachable calls are never parsed. Passes after it get the call graph for free.

Re-throw enrichment writes into the same store and names units with the same keys (falling back to line-based keys only when the closure didn't run, e.g. `includeReachable: false`). Note that its `siteCalls` relation differs from the closure's `calls` on purpose: `calls(u, v)` means "u statically calls v anywhere", while `siteCalls(site, v)` scopes the call to one rethrow site's try block. Collapsing them would over-propagate throw sources through calls outside the try.

## Relations in production

| Relation | Arity | Emitted by (owner) | Meaning |
|----------|-------|--------------------|---------|
| `entry` | 1 | reachable closure | unit is a pack-discovered entry point |
| `calls` | 2 | reachable closure | unit statically calls unit |
| `reachable` | 1 | derived (closure rules) | unit is reachable from some entry |
| `unitEffect` | 3 | boundary effects | unit's transitions carry effect (kind, target) |
| `reachFrom` | 2 | derived (effect rules) | unit is reachable from this specific entry |
| `boundaryEffect` | 3 | derived (effect rules) | entry transitively reaches effect (kind, target) |
| `throwsDirect` | 2 | rethrow enrichment | unit has a throw terminal with this source |
| `rethrowSite` | 2 | rethrow enrichment | unit re-throws from a catch at this site |
| `siteCalls` | 2 | rethrow enrichment | that rethrow site's try block calls this unit |
| `contributes` | 2 | derived (rethrow rules) | a throw source reaches this unit's re-throw |

Derived results surface to users as:

- `library` summaries with `recognition: "reachable"` (from `reachable`);
- resolved messages on re-throw transitions' metadata (from `contributes`);
- `metadata.effectsClosure: Array<{ kind, target, transitive }>` on entry summaries (from `boundaryEffect`): what a boundary's promise transitively rests on, with `transitive: true` when the effect lives on a callee. This is the raw material for cross-boundary cascade analysis. Join a provider's effects closure against other boundaries' identities and you can see which promises depend on which.

## Adding an analysis

1. **Name the question as relations.** What facts would make the answer a join? Keep each relation's tuple flat: strings and numbers, no objects.
2. **Emit facts from Layer 1.** Find the pass that already walks what you need (usually the closure pass) and add `db.add(...)` calls there, or write a small emitter that walks summaries. Walking summaries beats walking the AST when the information is already in the IR.
3. **Write the rules as data** next to the pass, as a `const RULES = [...]` the tests can import. Rules with negation: make sure every variable in a negated literal is bound by a positive literal first, and expect `stratify` to reject cycles.
4. **Stamp results in Layer 3** as additive metadata on summaries, sorted for stable output.
5. **Test at two levels:** unit tests on the rules with a hand-built database (no ts-morph anywhere in the test), and one adapter-level test proving the end-to-end stamp (see the transitive-effects test in `adapter.test.ts` for the pattern).

Two kinds of work do not belong here. Per-function local analysis stays in the path engine, which handles a single function's control flow directly; locality means the fixpoint machinery buys nothing. And anything that needs to consult the type checker mid-derivation should resolve first and emit facts after.

## Where this is going

- **CFG edges as facts.** The path engine's enumeration is equivalent to a query over the lowered control-flow graph. Materializing `cfgEdge` facts into the shared store would let path-sensitive analyses (`mayThrow` through plain calls, path-scoped effect attribution) be written as rules instead of new traversals.
- **Cascade checking.** `effectsClosure` joined across summaries gives "which boundaries' promises rest on which other boundaries". The checker-side join is unwritten.
- **A second language.** The adapter contract, seen from this layer, is: discover units, emit summaries, emit these facts. Layers 2 and 3 come along unchanged.
