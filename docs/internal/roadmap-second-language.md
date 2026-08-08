# Roadmap: the second language

How suss extends beyond TypeScript without importing another language's toolchain. We wrote it to pin the design down before it's needed, and nothing here is scheduled. Python is the running example, but the recipe works for any language.

## The constraint

**No target-language tooling in the analyzer.** Analyzing Python must not require a Python interpreter, pip packages, or shelling out to Python-native analyzers. The static path (extract, check, inspect) runs entirely inside the npm-shipped Node toolchain, same as today. The target runtime does appear where code *executes*; see the last section.

This is the same call as the standing "no native binaries in the npm-shipped core" rule (see the Soufflé verdict, decision #57 discussion): simple distribution is a product feature, and every external toolchain is one more thing to support.

## What the architecture already settled

The facts-and-rules layer ([`facts-and-rules.md`](facts-and-rules.md)) is the language-independent half, built and in production. All we ask of a second adapter is that it discover units, emit summaries in the shared IR, and emit the same facts (`entry`, `calls`, `unitEffect`, `throwsDirect`, and the rest). Everything above that layer comes along unchanged: reachability, effect closures, exception flow, cross-boundary checking, the CLI.

What someone has to build for a new language is its Layer 1, the per-function extractor. There are four pieces.

### 1. Parsing: tree-sitter, WASM build

`web-tree-sitter` plus the target grammar compiled to WASM ships over npm like any other dependency. No native compile step on install, no toolchain requirements. Grammars exist for every plausible next language. We have settled this one, and there is nothing to design.

tree-sitter provides syntax only. It has no symbol tables, types, or bindings. Pieces 3 and 4 exist because of that.

### 2. Path engine: abstract it once

The condition engine's idea (enumerate entry-to-terminal paths over *structured* statements, one transition per path, opacify loops, degrade to declared opacity on statement forms it doesn't model) is not a TypeScript idea. Python's statement forms map directly:

| TypeScript | Python | Engine treatment |
|---|---|---|
| `if` / `else if` / `else` | `if` / `elif` / `else` | identical |
| `switch` | `match` | case-group lowering carries over |
| `for` / `while` | `for` / `while` (plus the `else` clause) | opacification carries over; loop-`else` is one new edge kind |
| `try` / `catch` / `finally` | `try` / `except` / `finally` | opaque catch condition carries over; multiple `except` arms are the switch-group pattern |
| `return` / `throw` / `break` / `continue` | `return` / `raise` / `break` / `continue` | identical |

Here is the move. Pull the enumeration core in `paths/pathConditions.ts` out against a small `StructuredStatement` interface (statement kind, condition expression handle, children, exit kind), written once. Each language then provides a thin lowering from its tree-sitter grammar to that interface. **Do this extraction when the second language starts, not before.** An interface guessed from one language is worse than a port guided by two concrete cases.

### 3. Name resolution: build the modest version, on purpose

This is what ts-morph's type checker gives TypeScript for free, and it is the piece people reach for heavy tooling to replace. The constitution makes the job smaller: extraction only needs to classify a name as parameter, local, import, or can't-tell. Because can't-tell is a legal, declared answer (`unresolved` becomes an opaque condition), the resolver only has to avoid being wrong. It never has to be complete. What that takes is a lexical scope binder (module, class, and function scopes, assignments, imports), which someone can build in TS over the tree-sitter tree in bounded effort. Python's scoping rules are small, and `global` and `nonlocal` are edge cases to model rather than blockers.

Nothing in the IR needs types to be correct; `shape` fields degrade to opaque or unknown. If a design partner needs Python shapes, we can add stub-based enrichment (typeshed) as a later layer, in the same slot the TS type checker occupies (piece 4 of the TS adapter, which is explicitly the language-specific step).

### 4. Adjudication: the fuzzer decides "good enough"

The differential fuzzer is how we know the resolver and path lowering meet the bar without trusting anyone's judgment. It follows the same protocol as [`differential-fuzzing.md`](differential-fuzzing.md): generate programs in the target language from a small DSL, extract through the full pipeline, execute, compare. A condition fabricated by bad name resolution is a `falseClaim`, which fails the build. Abstention shows up as a measurable unknown rate, never as a failure. The gap corpus, and promoting a case once it is fixed, carry over unchanged.

## What about stack graphs and SCIP?

Stack graphs (GitHub's declarative name-resolution engine) and SCIP indexes solve name resolution generally: cross-repository, dependency-spanning, navigation-grade. We rejected both as foundations for the same three reasons. They have native Rust cores, which the no-native-binaries rule forbids. They bring their own languages for writing rules and their own index formats, and each one is something more to maintain. And they solve a bigger problem than we have: we need a binding that is either resolved or opaque, so paying for navigation-grade precision buys nothing on top of that.

They stay available as accelerators behind the seam. Subject resolution is one function with a narrow contract (name in, one of parameter / local / import / unresolved out), so an index-backed implementation can replace the hand-written one for a given language without anything above noticing. Revisit this when hand-writing scope resolvers has shown itself to be a repeated cost across two or more languages, not before.

## Where the target runtime legitimately appears

Two places execute code, and only there:

- **Differential fuzzing** runs in suss's own CI. Adding a Python target means Python in our CI image, never in the shipped package or the user's install.
- **`suss corroborate`** executes the *user's* handlers. For Python that means shelling out to the user's own interpreter, which anyone analyzing a Python codebase has by definition. It is opt-in and experimental, under the same contract as today.

## Order of work, when it starts

1. Pick the language with a design partner attached (the Salsa-incrementality lesson: infrastructure lands when a concrete case forces it).
2. Extract the `StructuredStatement` interface from the TS path engine; verify zero behavior change under the existing fuzzer.
3. Build the tree-sitter frontend: unit discovery, lowering, and the lexical resolver, driven by ported adapter fixtures.
4. Write the first pack for the new language (the Flask or FastAPI analog of Express). Packs stay declarative data, so this is recognition only.
5. Stand up the fuzzer target for the new language; the sound tier must run with zero findings before anything ships.
6. Emit facts. Rules and checking start working with no new work. That this is all the step takes is what the facts layer bought us.

## Amended

The language-adapters proposal (`proposals/language-adapters.md`)
grounds this design in a measured corpus and amends it in two
places. The resolver includes repo-scoped module resolution, not
only single-file classification. And the allowance for Rust behind
TypeScript, with WASM as the shipped default, replaces the
native-binary ban. Where the two documents disagree, the proposal
is current.
