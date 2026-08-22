# A second language, and the third

We have made the gating call: once CFN coverage reaches its bar and
the queue, bus, storage, and frontend fundamentals are in place, suss
reads Python, then Ruby. The design foundation already exists:
[`roadmap-second-language.md`](../roadmap-second-language.md) pinned
the constraint, the four-piece adapter recipe, the modest name
resolver, and the verification story before any of this was
scheduled. That document was a bet made before we measured anything.
Here we ground it in a measured corpus, keep what the measurement
confirmed, correct it in the two places named below, and add the
commitments the review process demanded.

## What the measurement added

A read-only baseline over the Python corpus (a private set of
production repos, and the numbers live in the run's report rather
than here) found what a first adapter has to handle:

- One internal wrapper framework, wrapping flask-restx, declares
  the routes for the majority of the services. FastAPI covers most
  of the rest, plain Flask comes after that, and Django and GraphQL
  are absent.
- Routes and verbs are string literals on decorators and class
  methods. Responses are declared model classes, which we can read
  as field lists with no inference.
- The async architecture is EventBridge and SNS centric, with SQS
  nearly absent, which reorders the SDK-recognition work.
- The deploy side is CFN/SAM plus Serverless Framework yaml, no
  Terraform, and the CFN reader already recognized every Lambda in
  every readable template.
- The frontends pair: client call sites correspond one-for-one to
  the declared routes, so the payoff lands as soon as both sides
  extract.

The detail that decides this is that the route primitives reach
application code as imports of a known module, either directly or
through the one wrapper package. To recognize them we need a name
classified as an import of module X, plus a wrapper module name the
pack configures. That is the same mechanism the TypeScript packs
use: the decorated-route patterns already accept a list of
importModule values for a decorator re-exported through a wrapper,
and the axios factories option shows what the config for naming one
looks like. None of it needs site-packages resolution, stubs, or
a type checker.

Two corrections to the roadmap follow from this. Its resolver only
classifies within a single file, and that is too narrow. Cross-file
value tracing is where the payoff is, so v0 includes repo-scoped
module resolution, emitted as facts: an import maps to the repo file
it points to, deterministically, and it abstains when the answer is
ambiguous. And its ban on native binaries no longer applies. The
standing constraint allows Rust behind TypeScript, which we have not
used so far, so WASM stays the shipped default and we permit native
bindings if a performance measurement justifies them.

Dependencies stay boundaries by default: suss recognizes an
installed package by name and does not read its insides. Analyzing a
dependency on purpose is a coherent later feature. You give it a
package, and suss adds that package's installed source as one more analysis
root and extracts summaries for it, which bootstraps the
package-exports story without waiting for library authors. It is out
of scope for v0, and it needs no engine beyond a step that locates
the package.

## Decisions

**Parser: tree-sitter, WASM, swappable.** The lowering into
StructuredStatement and facts is the seam, and the parser is behind
it. tree-sitter wins on the grammar ecosystem Ruby will use anyway,
on mature WASM bindings with no build pipeline of ours, and on its
query language fitting packs-as-data. Its Python grammar can lag
new syntax, so the fuzzer and corpus runs report the parse-failure
rate, and the named fallback is a WASM build of ruff's parser
(published on crates.io, higher fidelity, syntax-only, a swap
behind the seam rather than a redesign). RustPython's parser is the
third option on file.

**Resolution: our stack.** We use the lexical binder, the
repo-scoped module resolver, and the existing facts and rules. No
third-party analysis engine.

**Types: annotations are read in v0; inference is not built.**
This is contract reading, not type checking. FastAPI's declared
contract IS its annotations (parameters and response_model), so the
pack cannot work without reading them. Pydantic models are annotated
field blocks that we read the same way, and flask-restx declares its
models through explicit model calls. All of it is syntax we already
parse. What stays out is inference: propagating unannotated values,
resolving types across modules, stubs. The condition for revisiting
that is measured rather than open-ended: after the path-engine
slice, if the opacity rate is high in code that has annotations,
stub-based enrichment goes in the slot the roadmap reserved. In the corpora we
target, annotation coverage is thin, so inference buys the least
exactly where we point the tool.

## The engine evaluation, recorded

We evaluated three heavier engines against the roadmap's
hand-rolled resolver, prompted by the worry about type resolution.
We declined all three, each for reasons worth keeping on file:

- **Pyright.** It is written in TypeScript, so it passes the
  no-target-runtime rule, and its import resolution is the hardened
  article. It fails on two counts, packaging and necessity.
  pyright-internal is marked private and never published, so using
  it means vendoring a monorepo subtree or trusting a republish by
  one maintainer, which is a lower bar than the switch criteria we
  apply to ty below. And the measured corpus does not need what only
  pyright offers, per the section above. If a later corpus does need
  it, the resolver seam the
  roadmap defines (name in, classification out) is where an
  index-backed or engine-backed implementation slots per language.
- **ty.** Checked as of this writing: beta on 0.0.x versioning with
  breaking changes allowed between any versions, CLI and language
  server only, no embedding story, and Astral now belongs to
  OpenAI. We are watching it, with switch criteria: a stable
  release, a supported embedding path, and module-resolution parity
  on the corpus, plus the standing native-binary rule if the path is
  bindings rather than WASM.
- **Stack graphs and SCIP.** Already rejected in the roadmap for
  three reasons that held up under re-examination: native cores,
  new authoring surfaces, and navigation-grade precision above the
  answer-or-abstain bar extraction actually needs. Their scope-stack
  vocabulary is still worth borrowing when we write the per-language
  fact extraction, so that we model lexical scoping deliberately.

## What this proposal adds to the roadmap

**Fact-vocabulary additions, named now.** Python needs two things
the current relations cannot express. The first is an open-import
relation for `from module import *`, resolved lazily by a fallback
rule rather than by eagerly expanding a module's export surface.
The second is decorator lowering, where `@app.route("/x")` desugars
into two call facts, the factory application and the decoration,
before any resolution rule sees it. The parameterized decorator is
the common case rather than the bare one, and the lowering handles
that. Dynamic attributes degrade to unresolved under the existing
convention, and they need only a stated test.

**What v0 findings actually are.** Summaries with only boundaries
reach the existence class: a route with no caller, a caller with no
route, a channel with no counterpart, and the same across languages
once both sides extract, since the checker keys pairing on bindings
alone. The disagreement class (coverage, contract consistency, body
compatibility) needs transitions, and it arrives with the
path-engine port rather than in v0. Each slice below says which
class it delivers, so nobody reads "useful" as more than it is.

**Cross-language pairing is a goal, not an accident.** A Python
provider checked against a TypeScript consumer is the capability a
second language actually unlocks in a polyglot repo, and the
measured corpus has exactly that in it. It becomes a named
acceptance test: the corpus's frontend client summaries pair
against the Python routes with existence findings, before any
Python transition work. A small invented fixture that shows how the
wrapper framework is put together, sourced from nothing, anchors the
Python slices the way the ALB fixture anchors flow-reachability, and
it lands with slice 2.

**Invariants for the deferred pack vocabulary.** The match kinds
stay per-language, and we still extract the shared core after the
second implementation, per the standing rule. Three invariants cost
nothing now and keep the reconciliation from turning into
archaeology. New fact relations follow the existing naming
conventions and pass the does-it-widen-shared-vocabulary question
walkers-and-rules already asks. The pack fields that are
protocol-level and adapter-agnostic (kind, protocol,
responseSemantics, vocabulary) are declared as such, so only the
match kinds fork. And every new Python match type records its TS
analogue or says that none exists.

**Ruby, now measured.** The baseline ran over the two private
Rails repos and inverted the guessed priorities. The dominant
surface is graphql-ruby rather than routes: two thousand field
declarations, effectively all of them literal type references,
either directly or one named-class hop away, and none computed. The
corpus never uses the resources macro at all, so the
macro-expansion risk we priced retires for these repos. The route
risks that do exist are gem macros (an auth gem's route helper),
mounted engines, constraint blocks, and route data that goes
through a checked-in JSON file, and a reader records those as
unbounded rather than silently dropping them, since the baseline
showed one concrete false negative from a macro nobody expanded. So
the Ruby slice order flips: a graphql-ruby field and type reader
first, pairing immediately against the apollo-client extraction
that already works on their frontends, then routes.rb with the
opacity conventions above. Pairing off checked-in SDL dumps works
today. What the adapter adds is source truth and backend scoping,
since the baseline caught a wrong-provider false positive where one
frontend speaks to two GraphQL backends and only source-level
scoping tells them apart.

**Verification, restated so this document can be read on its own.**
The roadmap's answer still applies unchanged, and it is the answer
here too. Differential fuzzing for a new language runs that language
in suss's own CI image only, never in the shipped package. The
fuzzer adjudicates the resolver and the path lowering with the same
protocol where a falseClaim fails the build. And `suss corroborate`
shells out to the user's own interpreter, opt-in, which anyone
analyzing that language has by definition.

## Slices, revised

1. **StructuredStatement extraction** from the TS path engine, per
   the roadmap, and the roadmap's own verification bar is binding:
   zero behavior change under the existing fuzzer, and summaries
   byte-identical across the refactor. This is the narrow reading
   of "extract the interface", written out so nobody reads it
   wider: the enumeration core, not a four-piece rewrite
   of the adapter's 74 files. The coarse adapter surface (extract from files, extract
   all) gets its language-neutral name in the same slice, and the
   one consumer that reaches through it for the ts-morph project
   (corroborate) gets an explicit TS-only accessor rather than a
   pretend-neutral field.
2. **Python frontend v0**: tree-sitter WASM parsing, unit
   discovery for decorated functions and class methods, the
   lexical resolver, decorator lowering, literal route and verb
   extraction, the structures declared by model classes, fact
   emission including the open-import relation. Everything else opaque at
   low confidence. Delivers the existence class, including the
   cross-language acceptance test.
3. **The first Python packs**: flask-restx with the wrapper-module
   config, then FastAPI, then plain Flask, with EventBridge and
   SNS SDK recognition ahead of SQS per the measurement.
4. **The Python fuzzer target**, sound tier passing before
   anything ships, per the roadmap's adjudication protocol.
5. **The path-engine lowering for Python**, turning the existence
   class into the disagreement class where conditions decompose,
   and the measured unknown rate says where they do not.
6. **The serverless.yaml reader** (filed separately) in front of
   existing summary builders, independent of all of the above.
7. **Ruby baseline, then Ruby v0** on the same recipe, with the
   macro-expansion pricing as the baseline's first question.
8. **Extract the shared pack core** from what the implementations
   repeated, per the standing rule, aided by the invariants above.

## Risks

- **The resolver misclassifying instead of abstaining** is the
  failure that matters. The fuzzer's falseClaim protocol is the
  gate, and the unknown rate is the cost metric, which we report
  rather than hide.
- **The wrapper-module config underfitting** wilder wrapping
  styles than the corpus's (re-exported decorators, dynamic
  namespace registration). The measurement says the simple config
  covers the dominant case. The fallback is the standard one,
  unresolved and stated, and the axios cross-file work shows the
  upgrade path when a corpus demands more.
- **WASM parsing cost** at monorepo scale, unmeasured. The roadmap
  chose WASM for distribution simplicity. The Python fuzzer and
  corpus runs produce the numbers, and native bindings remain the
  escape hatch behind the same parse seam if the measurement
  objects, weighed against the native-binary rule.
- **Two documents, one plan.** This proposal amends the roadmap
  where the two disagree (resolver scope, the native binary rule),
  and a note in the roadmap points here so nobody can cite the
  stale parts as settled.
