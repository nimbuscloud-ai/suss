# Roadmap: the second language

How suss extends beyond TypeScript without importing another language's toolchain. Written to pin the design before it's needed; nothing here is scheduled. Python is the running example, but the recipe is language-generic.

## The constraint

**No target-language tooling in the analyzer.** Analyzing Python must not require a Python interpreter, pip packages, or shelling out to Python-native analyzers. The static path (extract, check, inspect) runs entirely inside the npm-shipped Node toolchain, same as today. Where code *executes*, the target runtime legitimately appears; see the last section.

This is the same call as the standing "no native binaries in the npm-shipped core" rule (see the Soufflé verdict, decision #57 discussion): distribution simplicity is a product feature, and every external toolchain is a support surface.

## What the architecture already settled

The facts-and-rules layer ([`facts-and-rules.md`](facts-and-rules.md)) is the language-independent half, built and in production. A second adapter's whole contract is: discover units, emit summaries in the shared IR, emit the same facts (`entry`, `calls`, `unitEffect`, `throwsDirect`, and the rest). Everything above that layer comes along unchanged: reachability, effect closures, exception flow, cross-boundary checking, the CLI.

What a new language needs built is its Layer 1, the per-function extractor. Four pieces.

### 1. Parsing: tree-sitter, WASM build

`web-tree-sitter` plus the target grammar compiled to WASM ships over npm like any other dependency. No native compile step on install, no toolchain requirements. Grammars exist for every plausible next language. This is the settled answer; nothing to design.

tree-sitter provides syntax only. It has no symbol tables, types, or bindings. Pieces 3 and 4 exist because of that.

### 2. Path engine: abstract it once

The condition engine's idea (enumerate entry-to-terminal paths over *structured* statements, one transition per path, opacify loops, degrade honestly on unmodeled shapes) is not a TypeScript idea. Python's statement forms map directly:

| TypeScript | Python | Engine treatment |
|---|---|---|
| `if` / `else if` / `else` | `if` / `elif` / `else` | identical |
| `switch` | `match` | case-group lowering carries over |
| `for` / `while` | `for` / `while` (plus the `else` clause) | opacification carries over; loop-`else` is one new edge kind |
| `try` / `catch` / `finally` | `try` / `except` / `finally` | opaque catch condition carries over; multiple `except` arms are the switch-group pattern |
| `return` / `throw` / `break` / `continue` | `return` / `raise` / `break` / `continue` | identical |

The move: extract the enumeration core in `paths/pathConditions.ts` against a small `StructuredStatement` interface (statement kind, condition expression handle, children, exit kind), written once; each language provides a thin lowering from its tree-sitter grammar to that interface. **Do this extraction when the second language starts, not before.** An interface guessed from one language is worse than a port guided by two concrete cases.

### 3. Name resolution: build the modest version, on purpose

This is what ts-morph's type checker gives TypeScript for free, and the piece people reach for heavy tooling to replace. The constitution shrinks it: extraction needs to classify a name as parameter, local, import, or can't-tell. Because can't-tell is a legal, honest answer (`unresolved` becomes an opaque condition), the resolver only has to avoid being wrong; it never has to be complete. That is a lexical scope binder (module, class, and function scopes, assignments, imports), buildable in TS over the tree-sitter tree in bounded effort. Python's scoping rules are small; `global` and `nonlocal` are edge cases to model, not blockers.

Types are not required for correctness anywhere in the IR; `shape` fields degrade to opaque or unknown. If a design partner needs Python shapes, stub-based enrichment (typeshed) is an additive later layer, the same slot the TS type checker occupies (piece 4 of the TS adapter, explicitly the language-specific step).

### 4. Adjudication: the fuzzer decides "good enough"

The differential fuzzer is how we know the resolver and path lowering meet the bar without trusting anyone's judgment. Same protocol as [`differential-fuzzing.md`](differential-fuzzing.md): generate programs in the target language from a small DSL, extract through the real pipeline, execute, compare. A fabricated condition from bad name resolution is a `falseClaim`, which fails the build. Honest abstention shows up as a measurable unknown rate, never as a failure. The gap corpus and promote-on-fix lifecycle carry over unchanged.

## What about stack graphs and SCIP?

Stack graphs (GitHub's declarative name-resolution engine) and SCIP indexes solve name resolution generally: cross-repository, dependency-spanning, navigation-grade. Both are rejected as foundations for the same three reasons. They carry native Rust cores, against the no-native-binaries rule. They bring their own rule-authoring languages and index formats, each a new maintenance surface. And they solve a bigger problem than we have; we need honest-or-opaque binding, and paying for navigation-grade precision buys nothing above it.

They stay available as accelerators behind the seam. Subject resolution is one function with a narrow contract (name in, one of parameter / local / import / unresolved out), so an index-backed implementation can replace the hand-written one per language without anything above noticing. Revisit when hand-writing scope resolvers is the demonstrated repeated cost across two or more languages, not before.

## Where the target runtime legitimately appears

Two places execute code, and only there:

- **Differential fuzzing** runs in suss's own CI. Adding a Python target means Python in our CI image, never in the shipped package or the user's install.
- **`suss corroborate`** executes the *user's* handlers. For Python that means shelling out to the user's own interpreter, which anyone analyzing a Python codebase has by definition. Opt-in and experimental, same contract as today.

## Order of work, when it starts

1. Pick the language with a design partner attached (the Salsa-incrementality lesson: infrastructure lands when a concrete case forces it).
2. Extract the `StructuredStatement` interface from the TS path engine; verify zero behavior change under the existing fuzzer.
3. Build the tree-sitter frontend: unit discovery, lowering, and the lexical resolver, driven by ported adapter fixtures.
4. Write the first pack for the new language (the Flask or FastAPI analog of Express). Packs stay declarative data, so this is recognition only.
5. Stand up the fuzzer target for the new language; the sound tier must run clean before anything ships.
6. Emit facts. Rules and checking light up with no new work; this step existing at all is what the facts layer bought.
