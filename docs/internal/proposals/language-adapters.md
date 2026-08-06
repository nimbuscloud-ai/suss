# A second language, and the third

The gating call is made: once the CFN coverage bar and the
queue/bus/storage/frontend fundamentals hold, suss reads Python,
then Ruby. This proposal settles how, and it is written for both
languages at once on purpose: the expensive decisions are the seams,
and a seam designed for exactly one new language is a seam designed
wrong.

The measured corpus behind the Python half found what a first
adapter must do to be useful: resolve a route decorator to the
shared internal package it was imported from, read route strings
and verbs off decorators and class methods, read declared response
shapes off model classes, and recognize SDK calls to the bus and
storage services. What it does not need on day one: type inference.
Routes are literals, the shapes are declared field lists, and the
rest degrades to opaque predicates at low confidence, which the IR
carries as a recorded state rather than a failure.

## The constraint

Adapters execute in TypeScript, or in Rust behind TypeScript
bindings. No target-language runtime: suss stays one npm install
that works in a CI container with no Python and no Ruby on it, and
nothing about a user's interpreter version can change what suss
reads.

## What stays fixed

The seams that already exist do not move.

- The extractor consumes `RawCodeStructure` and never sees syntax.
  It does not change.
- Whole-program analyses are rules over facts, and the rules never
  touch an AST. An adapter that emits the fact vocabulary (binds,
  imports, module exports, calls, the scope shapes its language
  needs) inherits reachability, value resolution, effect closures,
  and the flow walk. This was the stated payoff of walkers-and-rules
  and it is the reason a second adapter is a large slice rather than
  a second system.
- The resolution layer stays the one engine for cross-cutting
  questions. It answers value provenance, what a thing was written
  as, through bindings, re-exports, factory returns, and call
  arguments into parameters, which is more than name resolution and
  is the question suss actually asks. We evaluated stack graphs
  here: it answers where-is-this-defined with a rigor worth
  borrowing vocabulary from, per-file composition through scope
  stacks, but adopting it would stand a second resolution engine
  next to ours, its model stops at the definition site rather than
  following values through calls, and its public maintenance has
  gone quiet. Vocabulary yes, dependency no.

## The engine per language

An adapter owns its language and uses the best engine that exists
in-process for it. The TypeScript adapter already models this: it
leans on ts-morph and the compiler for single-language binding and
emits facts for everything cross-cutting.

**Python: Pyright, behind our own interface.** Pyright is a
TypeScript program, npm-installable, no Python runtime anywhere,
and it carries the one capability whose cost my parser-only
alternative underpriced: Python's import system. Relative imports,
packages, `__init__` re-exports, namespace packages, stubs; the
measured corpus's dominant pattern needs exactly this, because its
routing primitives arrive through a shared internal package.
Rebuilding that as facts and rules is a large, subtle project with
famous edge cases; Pyright has it hardened by a decade of Pylance.
The costs are named and contained: pyright-internal is an
unsupported API, so the version pins, and the adapter defines its
own narrow interface, resolve this module, bindings of this file,
declared shape of this class, with nothing of Pyright leaking
through, the same discipline ts-morph gets today.

**The successor candidate is ty, and the wrapper is the exit.**
Checked as of this writing: ty is beta on 0.0.x versioning with
breaking changes allowed between any two versions, ships as a CLI
and a language server with no library or bindings story, and
Astral now belongs to OpenAI with the team folded into their agent
platform org. The switch criteria, should it earn the swap: a
stable release, a supported embedding path, and module-resolution
parity on the corpus. Until all three, ty is a watched candidate,
not a layer the first adapter's schedule rests on, and the
acquisition is a reason the wrapper seam is the exit rather than
politeness. The same check
looked at ruff's own crates: the parser and per-file semantic
model are excellent and cross-module resolution is not what they
do, so they solve the part that was never the hard part here.

**Ruby: tree-sitter, and the manifest carries more of the load.**
No embeddable semantic engine exists for Ruby under the
constraint, so the Ruby adapter parses with tree-sitter (Rust
core, mature grammar, native or WASM bindings) and leans on the
fact layer for resolution. Two properties of Rails make this less
punishing than it sounds: `routes.rb` is a central declarative
manifest, closer to a contract file than scattered decorators, and
the boundary families Rails uses (ActiveRecord storage, Sidekiq
queues) map onto variants that already exist. Controller
conventions, implicit rendering, `before_action` chains, are where
opacity will concentrate, and staged degradation is the posture:
boundaries and routes early, behavior decomposition later, low
confidence stated rather than guessed around. No Ruby work starts
before a baseline run over a Ruby corpus, the same measurement the
Python half already has; the platform repo has Ruby and gets the
same read-only characterization when it is reachable.

## What a pack means across languages

Today's pattern vocabulary (`registrationCall`, `decoratedMethod`,
terminal shapes) is TypeScript-AST-shaped in practice, and the
architecture docs already warn against designing the shared
abstraction before the second implementation exists to shape it.
So: the pack interface stays the umbrella (a pack declares its
protocol, its discovery, its terminals, its vocabulary, and is
data), and each adapter defines the match vocabulary its language
supports. Where tree-sitter is the engine, a pack's patterns can be
tree-sitter queries, which keeps framework-support-is-data true in
a second language rather than TS-only. The genuinely shared core
gets extracted after the Python adapter exists, from what actually
repeated, not predicted in advance.

## Slices

1. **The adapter interface extraction.** Name the seam the TS
   adapter already implements implicitly (discover units, extract
   structure, emit facts, report gaps) so a second implementation
   has a contract to fill. No behavior change; the TS adapter
   conforms to its own extracted shape.
2. **Python adapter v0 behind Pyright.** Module resolution, unit
   discovery for decorated functions and class methods, literal
   route and verb extraction, declared shapes from model classes,
   fact emission, everything else opaque. Measured against the
   corpus: the target is boundaries that pair, not behavior depth.
3. **The first Python packs.** flask-restx first (one internal
   framework covering eight corpus repos), then FastAPI, then plain
   Flask, with boto3 SDK recognition for the bus and storage
   families riding the same slices.
4. **The serverless.yaml reader** (already filed) so the deploy
   side of those services stops being invisible; it is a schema
   translation in front of existing summary builders and can land
   independently of everything above.
5. **Ruby baseline, then Ruby adapter v0.** Characterize the Ruby
   corpus first; commit to the tree-sitter build only after the
   measurement says what Rails actually requires, with `routes.rb`
   reading as the likely first boundary source.
6. **Extract the shared adapter core** from what the second
   implementation repeated, per the standing rule.

## Risks

- **Pyright's API drift.** Contained by pinning and the wrapper;
  the exposure is upgrade-time breakage of our seam, visible at
  compile time, never silent misreading.
- **Dependency environments.** Pyright resolves third-party
  imports best with installed packages or stubs present. Absent
  them, resolution degrades to unresolved, which is the standard
  posture; the corpus's critical resolution target is the repo's
  own shared package, which needs no environment.
- **Native bindings for Ruby.** tree-sitter via WASM avoids the
  platform build matrix at some speed cost; the choice is deferred
  to the Ruby slice with WASM as the default until measurement
  objects.
- **The pack vocabulary forking per language.** Accepted
  deliberately, with the extraction slice at the end; the
  premature-abstraction failure is the one the architecture doc
  already documents, and the week's registry work shows what a good
  shared seam looks like when it is earned from instances.
