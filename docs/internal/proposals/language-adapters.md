# A second language, and the third

The gating call is made: once the CFN coverage bar and the
queue/bus/storage/frontend fundamentals hold, suss reads Python,
then Ruby. The design foundation already exists:
[`roadmap-second-language.md`](../roadmap-second-language.md) pinned
the constraint, the four-piece adapter recipe, the modest name
resolver, and the verification story before any of this was
scheduled. This proposal does not replace it. It grounds that
design in a measured corpus, prices the pieces the roadmap left
open, records an engine evaluation that ended by confirming the
roadmap's choice, and adds the commitments the review process
demanded.

## What the measurement added

A read-only baseline over the Python corpus (a private set of
production repos; numbers live in the run's report, not here) found
the shape a first adapter must serve:

- One internal wrapper framework, wrapping flask-restx, declares
  the routes for the majority of the services. FastAPI covers most
  of the rest; plain Flask trails; Django and GraphQL are absent.
- Routes and verbs are string literals on decorators and class
  methods. Response shapes are declared model classes, readable as
  field lists with no inference.
- The async architecture is EventBridge and SNS centric, with SQS
  nearly absent, which reorders the SDK-recognition work.
- The deploy side is CFN/SAM plus Serverless Framework yaml, no
  Terraform, and the CFN reader already recognized every Lambda in
  every readable template.
- The frontends pair: client call sites correspond one-for-one to
  the declared routes, so the payoff lands as soon as both sides
  extract.

The decisive detail: the route primitives reach application code as
imports of a known module, directly or through the one wrapper
package. Recognizing them needs a name classified as
import-of-module-X plus a pack-configured wrapper module name,
which is the same mechanism the TypeScript packs use: the
decorated-route patterns already tolerate a list of importModule
values for a decorator re-exported through a wrapper, and the axios
factories option shows the config shape for naming one. It does not need site-packages resolution, stubs, or
a type checker. The roadmap's resolver, a lexical binder that
answers parameter, local, import, or can't-tell, covers the
measured need.

## The engine evaluation, recorded

Three heavier engines were evaluated against the roadmap's
hand-rolled resolver, prompted by the type-resolution worry. All
three end declined, each for reasons worth keeping on file:

- **Pyright.** TypeScript, so it passes the no-target-runtime rule,
  and its import resolution is genuinely the hardened article. It
  fails on packaging and on necessity: pyright-internal is marked
  private and never published, so consuming it means vendoring a
  monorepo subtree or trusting a one-maintainer republish, a bar
  below the switch criteria this document holds ty to; and the
  measured corpus does not need what it uniquely offers, per the
  section above. If a later corpus does, the resolver seam the
  roadmap defines (name in, classification out) is where an
  index-backed or engine-backed implementation slots per language.
- **ty.** Checked as of this writing: beta on 0.0.x versioning with
  breaking changes allowed between any versions, CLI and language
  server only, no embedding story, and Astral now belongs to
  OpenAI. Watched, with switch criteria: a stable release, a
  supported embedding path, and module-resolution parity on the
  corpus, plus the standing native-binary rule if the path is
  bindings rather than WASM.
- **Stack graphs and SCIP.** Already rejected in the roadmap for
  three reasons that held up under re-examination: native cores,
  new authoring surfaces, and navigation-grade precision above the
  answer-or-abstain bar extraction actually needs. Their scope-stack
  vocabulary remains worth borrowing when writing the per-language
  fact extraction, so lexical scoping is modeled deliberately.

## What this proposal adds to the roadmap

**Fact-vocabulary additions, named now.** Python needs two things
the current relations do not express: an open-import relation for
`from module import *`, resolved lazily by a fallback rule rather
than by expanding a module's export surface eagerly; and decorator
lowering, where `@app.route("/x")` desugars to two call facts, the
factory application and the decoration, before any resolution rule
sees it. The parameterized decorator is the common case, not the
bare one, and the lowering owns that. Dynamic attributes degrade to
unresolved under the existing convention and need only a stated
test.

**What v0 findings actually are.** Boundary-only summaries reach
the existence class: a route with no caller, a caller with no
route, a channel with no counterpart, cross-language once both
sides extract, since the checker keys pairing on bindings alone.
The disagreement class, coverage, contract consistency, body
compatibility, needs transitions and arrives with the path-engine
port, not v0. The slices below say which class each delivers so
nobody reads "useful" as more than it is.

**Cross-language pairing is a goal, not an accident.** A Python
provider checked against a TypeScript consumer is the capability a
second language actually unlocks in a polyglot repo, and the
measured corpus contains exactly that shape. It becomes a named
acceptance test: the corpus's frontend client summaries pair
against the Python routes with existence findings, before any
Python transition work.

**Invariants for the deferred pack vocabulary.** The match shapes
stay per-language and the shared core still gets extracted after
the second implementation, per the standing rule. Three invariants
cost nothing now and prevent the reconciliation from becoming
archaeology: new fact relations follow the existing naming
conventions and pass the does-it-widen-shared-vocabulary question
walkers-and-rules already asks; the pack fields that are
protocol-level and adapter-agnostic (kind, protocol,
responseSemantics, vocabulary) are declared as such so only match
shapes fork; and every new Python match type records its TS
analogue or states that none exists.

**Ruby's risk named precisely.** `routes.rb` is not a manifest; it
is an executable DSL where `resources :orders` expands to up to
seven routes under the interaction of nesting, `only`, `member`,
and concerns, evaluated by Rails at boot. Recovering routes
statically means modeling that macro expansion by hand, and the
TypeScript adapter treats its nearest analogue (registration
loops) as a scoped-down edge case, where for Ruby it would be the
primary boundary source. The Ruby baseline exists to price exactly
this, and no Ruby commitment lands before it does. A small invented
fixture demonstrating the wrapper-framework shape, sourced from
nothing, anchors the Python slices the way the ALB fixture anchors
flow-reachability, and lands with slice 2. The platform
repo carries the Ruby corpus and gets the same read-only
characterization when reachable.

**Verification, restated so this document stands alone.** The
roadmap's answer carries over unchanged and is the answer here
too: differential fuzzing for a new language runs that language in
suss's own CI image only, never in the shipped package; the fuzzer
adjudicates the resolver and the path lowering with the same
falseClaim-fails-the-build protocol; and `suss corroborate` shells
out to the user's own interpreter, opt-in, which anyone analyzing
that language has by definition.

## Slices, revised

1. **StructuredStatement extraction** from the TS path engine, per
   the roadmap, with the roadmap's own verification bar stated as
   binding: zero behavior change under the existing fuzzer, and
   summaries byte-identical across the refactor. This is the
   narrow reading of "extract the interface", stated so nobody
   reads it wider: the enumeration core, not a four-piece rewrite
   of the adapter's 74 files. The coarse adapter surface (extract from files, extract
   all) gets its language-neutral name in the same slice, and the
   one consumer that reaches through it for the ts-morph project
   (corroborate) gets an explicit TS-only accessor rather than a
   pretend-neutral field.
2. **Python frontend v0**: tree-sitter WASM parsing, unit
   discovery for decorated functions and class methods, the
   lexical resolver, decorator lowering, literal route and verb
   extraction, declared shapes from model classes, fact emission
   including the open-import relation. Everything else opaque at
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
  failure that matters; the fuzzer's falseClaim protocol is the
  gate, and the unknown rate is the cost metric, reported rather
  than hidden.
- **The wrapper-module config underfitting** wilder wrapping
  styles than the corpus's (re-exported decorators, dynamic
  namespace registration). The measurement says the simple config
  covers the dominant case; the fallback is the standard one,
  unresolved and stated, and the axios cross-file work shows the
  upgrade path when a corpus demands more.
- **WASM parsing cost** at monorepo scale, unmeasured. The roadmap
  chose WASM for distribution simplicity; the Python fuzzer and
  corpus runs produce the numbers, and native bindings remain the
  escape hatch behind the same parse seam if measurement objects,
  weighed against the native-binary rule.
- **Two proposals, one design.** This document and the roadmap now
  describe one plan at two altitudes; the roadmap stays the
  constitution, this stays the grounded execution plan, and any
  future divergence between them is a bug in whichever changed
  second.
