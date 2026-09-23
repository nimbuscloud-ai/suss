# Roadmap: the second language

This is how suss can read languages other than TypeScript without importing another language's toolchain. We wrote it down to settle the design before anyone needs it, and nothing here is scheduled. Python is the running example, but the same steps work for any language.

## The constraint

**No target-language tooling in the analyzer.** Analyzing Python must not require a Python interpreter, pip packages, or shelling out to analyzers written in Python. The static path (extract, check, inspect) runs entirely inside the Node toolchain we ship over npm, as it does today. The target runtime does appear where code *executes*, which the last section covers.

We made the same decision with the standing rule against native binaries in the core we ship over npm (see the Soufflé verdict in the discussion of decision #57). Easy distribution is a product feature, and every external toolchain is one more thing to support.

## What the architecture already settled

The facts-and-rules layer ([`facts-and-rules.md`](../docs/theory/facts-and-rules.md)) is the half that works for any language, and it is built and in production. A second adapter only has to discover units, emit summaries in the shared IR, and emit the same facts (`entry`, `calls`, `unitEffect`, `throwsDirect`, and the rest). Everything above that layer then works unchanged: reachability, effect closures, exception flow, cross-boundary checking, and the CLI.

For a new language, someone has to build its Layer 1, the extractor that runs on each function. It has four parts.

### 1. Parsing: tree-sitter, WASM build

`web-tree-sitter` plus the target grammar compiled to WASM ships over npm like any other dependency. Nothing compiles natively on install, and the user needs no extra toolchain. Grammars exist for every language we might pick next. This part is settled and needs no design.

tree-sitter only gives you syntax. It has no symbol tables, types or bindings, and that is why parts 3 and 4 exist.

### 2. Path engine: abstract it once

The condition engine enumerates the paths from entry to terminal over *structured* statements, makes one transition per path, makes loops opaque, and falls back to declared opacity for statement forms it doesn't model. None of that is specific to TypeScript, and Python's statement forms map onto it directly:

| TypeScript | Python | Engine treatment |
|---|---|---|
| `if` / `else if` / `else` | `if` / `elif` / `else` | identical |
| `switch` | `match` | case-group lowering carries over |
| `for` / `while` | `for` / `while` (plus the `else` clause) | opacification carries over; loop-`else` is one new edge kind |
| `try` / `catch` / `finally` | `try` / `except` / `finally` | opaque catch condition carries over; multiple `except` arms are the switch-group pattern |
| `return` / `throw` / `break` / `continue` | `return` / `raise` / `break` / `continue` | identical |

The plan is to pull the enumeration core in `paths/pathConditions.ts` out behind a small `StructuredStatement` interface, written once. The interface has a statement kind, a handle on the condition expression, the children, and the kind of exit. Each language then provides a thin lowering from its tree-sitter grammar to that interface. **Pull the interface out when work on the second language starts, and not before.** An interface guessed from one language is worse than one shaped by two concrete languages.

### 3. Name resolution: build the modest version, on purpose

ts-morph's type checker gives TypeScript this part for free, and it is the part people reach for heavy tooling to replace. The constitution makes the job smaller. Extraction only needs to classify a name as a parameter, a local, an import, or can't-tell. Can't-tell is a legal, declared answer (`unresolved` becomes an opaque condition), so the resolver only has to avoid being wrong and never has to be complete. That takes a lexical scope binder covering module, class and function scopes, assignments and imports. Someone can build it in TypeScript over the tree-sitter tree with a bounded amount of work. Python's scoping rules are small, and `global` and `nonlocal` are edge cases to model and do not block anything.

Nothing in the IR needs types to be correct, because `shape` fields fall back to opaque or unknown. If a design partner needs Python shapes, we can add enrichment from type stubs (typeshed) as a later layer. It would go in the same place the TypeScript type checker has today, which is piece 4 of the TypeScript adapter, the step that is explicitly specific to the language.

### 4. Adjudication: the fuzzer decides "good enough"

The differential fuzzer tells us whether the resolver and the path lowering are good enough, without relying on anyone's judgment. It follows the same protocol as [`differential-fuzzing.md`](./docs-internal/differential-fuzzing.md). It generates programs in the target language from a small DSL, extracts them through the full pipeline, executes them and compares. A condition that bad name resolution made up is a `falseClaim`, and that fails the build. Abstention shows up as a measured rate of unknowns and never as a failure. The gap corpus, and promoting a case once it is fixed, work the same way.

## What about stack graphs and SCIP?

Stack graphs (GitHub's declarative name-resolution engine) and SCIP indexes solve name resolution in general: across repositories and dependencies, precise enough for code navigation. We rejected both as a foundation, for three reasons. They have native Rust cores, which the rule against native binaries forbids. They each bring their own language for writing rules and their own index format, which is more for us to maintain. And they solve a bigger problem than ours. We need a binding that is either resolved or opaque, so paying for precision good enough for navigation gets us nothing more.

We can still add them later to speed things up. Subject resolution is one function with a narrow contract: a name goes in, and one of parameter, local, import or unresolved comes out. So an implementation backed by an index can replace the hand-written one for a given language, and nothing above it would notice. Revisit this once hand-writing scope resolvers has turned out to be a repeated cost across two or more languages, and not before.

## Where the target runtime legitimately appears

Code executes in two places, and only there:

- **Differential fuzzing** runs in suss's own CI. Adding a Python target means Python in our CI image. It never goes in the shipped package or the user's install.
- **`suss corroborate`** executes the *user's* handlers. For Python that means shelling out to the user's own interpreter, which anyone analyzing a Python codebase already has. It is opt-in and experimental, under the same contract as today.

## Order of work, when it starts

1. Pick the language that has a design partner behind it. The lesson from Salsa's incrementality is that infrastructure gets built when a concrete case forces it.
2. Pull the `StructuredStatement` interface out of the TypeScript path engine, and check with the existing fuzzer that behavior does not change at all.
3. Build the tree-sitter frontend: unit discovery, lowering, and the lexical resolver, driven by adapter fixtures ported from TypeScript.
4. Write the first pack for the new language, the Flask or FastAPI counterpart of Express. Packs are still declarative data, so this only covers recognition.
5. Set up the fuzzer target for the new language. The sound tier must run with zero findings before anything ships.
6. Emit facts. Rules and checking then work with no new code. The facts layer is what made this step so small.

## Amended

The language-adapters proposal (`proposals/language-adapters.md`)
bases this design on a measured corpus and changes it in two places.
The resolver includes module resolution across the repo, on top of
classifying names in a single file. And the ban on native binaries is
replaced by an allowance for Rust behind TypeScript, with WASM as the
default we ship. Where the two documents disagree, the proposal is the
current one.
