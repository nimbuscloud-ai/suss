# What should be facts, and what should stay a walker

This is the one design for the fact layer and its consumers, and the
foundation 0.20.0 builds on. It was first written from measurements on
the TypeScript adapter; a full audit across all three adapters
(2026-08-28) folded in the sections on bypasses, the recognize surface,
cross-adapter parity, and the migration constraints, and set the order.

The policy the audit settled: when a question is "follow this value,
name, or module one more step", the answer is a one-hop fact plus a
rule, never a new walk. A walk that exists only because no fact does is
debt. What stays imperative is syntax normalization (peeling casts,
counting application layers, reading a decorator's name), per-function
structural analysis (the path engine, shape extraction), and any
closure whose order the language defines (Ruby's method resolution
order).

The resolution rules are one package. Discovery, terminal matching,
assembly and the whole checker are imperative TypeScript, and that is
where the bugs come from. Four recent ones, all traced:

- A checker pass matched a handler to a Lambda with `startsWith` on
  file paths and produced 1,894 findings, 1,307 of which pointed at the
  wrong function (#54).
- Discovery read the syntax at a registration position instead of
  resolving the value there, so `router.get("/users", listUsers)`
  produced nothing. Moving that one question to the fact layer took
  the NestJS pack from 7 boundaries to 434 on Twenty, and Express from
  0 to 52 on the Directus API (#70).
- `bodyShapesMatch` reports a match for two type references with the
  same name whatever they contain, so two repositories that each declare
  a `User` agree after their fields drift.
- The transitive import gate was a hand-written walk memoised per
  pack. Two rules replaced it and cut one corpus from 29.7s to 16.3s
  (#72).

The claim to test is that moving a question into rules makes it both
faster and more correct. It does not always. So what follows says where
it has, where the evidence says it would, and where the code should stay
where it is.

Numbers from the public dogfood targets are given in full. Runs against
a production monorepo are described as ratios or as counts of findings,
which reveal nothing about how that codebase is put together.

## Two things decide the ranking

**Does imprecision there cost time, or would rules mean asking a new
question?** Where the fix was to stop tracking possibilities nobody
needed, correctness and speed moved together. Stopping the expansion of
library types made the output 84 times smaller and extraction about 20%
faster. Composing two property rules deleted one that derived nothing
and cut engine time 7 to 21% with identical summaries. The clearest
case is the `unwrapsProperty` rule that was taken out: it produced
several candidates for one value, which nulled sixty handlers and cost
time, one cause and two symptoms.

Where the fix was to ask a question nobody was asking, the two moved
apart. Resolving what an export actually is found 2,034 units that were
invisible and cost 3.4 times the wall clock.

A candidate of the first kind pays twice and ranks above one of the
second kind even where the second finds more. Each entry below says
which it is and what puts it there.

**Negation is unaffordable, and the reason is narrower than it looks.**
`canResume` in `@suss/datalog` returns false when *any* rule in the set
has a negated literal, so the whole set's derivations are retracted
and rebuilt from base facts. The resolution store evaluates after every
wave of facts arrives, so a rule set with one negated literal anywhere
pays for a full re-derivation per wave. A reaching-definitions design
that used negation took one corpus from 66 seconds to not finishing in
ten minutes. The stratifier itself is fine; the resume flag is what
costs the time. Candidates whose natural formulation needs negation are
marked blocked, and the section on the path engine says what fixing the
flag would have to buy.

## Inventory

Sizes are non-test lines. "Asks" means the module calls the resolution
store; "walks" means it works the same question out itself.

| module | lines | the question it answers | asks or walks | who else needs it |
| --- | ---: | --- | --- | --- |
| `discovery/graphqlShared.ts` | 789 | what document does this argument denote | asks (`resolveWrittenValue`) | 3 graphql recognizers |
| `discovery/registrationCall.ts` | 382 | what did this registration call hand a route to | asks (`resolveCallable`, `resolveObject`) | none |
| `discovery/registrationTemplate.ts` | 309 | what routes does one helper call represent | walks | `registrationLoop` |
| `discovery/resolverMap.ts` | 307 | which function implements which `Type.field` | asks (has the store since #674's round) | `registrationTemplate`, `registrationLoop` |
| `discovery/packageImport.ts` | 239 | which functions call into a targeted package | walks, never given the store | `factoryTracking` |
| `discovery/registrationLoop.ts` | 234 | which loop over a route array registers what | walks | `resolverMap` |
| `discovery/factorySurface.ts` | 183 | what callable surface does a factory expose | walks | none |
| `discovery/namedExport.ts` | 179 | which function is this named export | asks in 2 of 4 passes | `fileConvention` |
| `discovery/decoratedMethod.ts` | 174 | which methods are resolvers | asks for the class, walks for the method | `decoratedRoute` |
| `discovery/factoryTracking.ts` | 166 | which local name a tracked import is bound to | walks (hand-rolled scope table) | `packageImport` |
| `terminals/returns.ts` | 610 | what outcome does this path produce | walks | none |
| `terminals/helperResolution.ts` | 456 | what can this helper return, per call site | walks, no memo | none |
| `terminals/extract.ts` | 409 | what status and body does a terminal have | config-driven mapping | none |
| `terminals/jsx.ts` | 297 | what render tree does this return | recursive structural mapping | none |
| `terminals/throws.ts` | 130 | what does this throw contain | flat mapping | none |
| `paths/pathConditions.ts` | 862 | which conditions gate each terminal | enumerates paths | nothing today |
| `assembly.ts` | 271 | compose the above into branches | composition | none |
| `checker/message-bus/messageBusPairing.ts` | 732 | who produces and consumes each channel | walks | `runtimeConfigPairing` |
| `checker/pairing/semanticBridging.ts` | 506 | does the consumer test what tells two bodies apart | walks | none |
| `checker/pairing/graphqlPairing.ts` | 458 | does every selected field have a resolver | walks | none |
| `checker/runtime-config/runtimeConfigPairing.ts` | 453 | does every env read have a declaration | walks | `messageBusPairing` |
| `checker/story/componentStoryAgreement.ts` | 322 | does every story arg match a prop | walks | none |
| `checker/body/bodyCompatibility.ts` | 317 | does the body contain the fields that get read | recursive walk | `consumerContract` |
| `checker/storage/relationalPairing.ts` | 266 | does every column named exist | walks | `runtimeConfigPairing` |
| `checker/coverage/providerCoverage.ts` | 204 | is every status handled | walks | `consumerSatisfaction`, `contractConsistency` |
| `checker/scope/unitScope.ts` | 88 | does this code run in this unit | predicate, callers supply the path test | 3 call sites |
| `ir-core/typeShapeMatch.ts` | 204 | does this body satisfy that one | recursive compare | 5 call sites |

### The store is bypassed where it matters most

The 2026-08-28 audit found the sharpest cases are not modules missing
from the table above but places the store exists and is not asked.

- **`callOps.ts:461` prefers syntax over the store.** The value step
  every declared pack rides on reads
  `variableFor(step)?.getInitializer() ?? resolve(step)`: the local
  initializer wins, and the store is asked only when there is none. A
  local `const client = wrap(base)` short-circuits the `unwraps`
  rules, `settled` caps at four hops and returns null in a way that
  makes a deep chain and a cycle look identical, and the curried
  creator (`create<T>()(init)`) dies in `rootIdentifier`, which
  returns null for a callee that is itself a call. One preference
  flip reaches every declared pack.
- **`packageImport.ts` and `factoryTracking.ts` are never handed the
  store.** Their headers enumerate nine recognized call spellings and
  five out-of-scope ones (reassignment, parameter passthrough,
  namespace imports, re-exports, receiver chains); every out-of-scope
  spelling is an existing relation (`moduleExport`, `passesArgument`,
  `binds`). This walker is why #429 is open, and the injected-client
  shape from the field report is the same missing edge.
- **`moduleExports.ts` asks ts-morph instead of `moduleExport/3`.**
  The file is a stack-machine rewrite of ts-morph's recursive alias
  resolution, with three `RangeError` catches and the stderr fallback
  that drops exports (#177). The relation is already derived,
  terminating, and stackless; deleting the walk deletes the fallback.
- **`ReceiverOrigin` has two members and needs six.** `factoryMade`,
  `imported`, `anchored`, `inherits`, and `global` (#542) are each an
  entry in every adapter's dispatch table today, and all of them are
  `comesFrom` queries. The recognize ops that exist to compensate for
  walk distance (`callee()`, the eight-hop receiver budget,
  `namedCallee`) shrink with them; mongoose's three-way
  `modelFactoryCall(receiver) ?? callee() ?? receiver.receiver()`
  disjunction is the pattern at its clearest.
- **Mount composition is a closure in TypeScript and a one-hop
  abstention in Python.** `mountPrefix.ts` hand-rolls a memoized,
  cycle-guarded closure with its own agreement semantics; the Python
  `routers.ts` abstains one hop deep, which is the unresolved half of
  #251 and 148 unpathed routes on the field corpus. As
  `mounted(child, parent, prefix)` facts and one `mountPath` closure,
  both adapters compute the same paths, and a router mounted twice is
  two derivations, which is #689's boundary-per-mount falling out of
  the same rule.
- **Ruby joins facts out of the `Database` by hand.** The Ruby
  adapter's `storage.ts` recursively filters `extendsNamed`,
  `extends`, and `binds` tuples in TypeScript, per call site, over
  relations already sitting in the engine. Python's `storage.ts` is the
  same shape one level up: the rules do one hop and imperative code
  does the star, with hand-rolled demand management. Each becomes two
  rules (`reachesBase`; `reachesStorage` over `bodyCallsDeep`).
- **The one-hop origin predicates.** `isImportedFrom` and
  `methodDeclaredIn` are path-substring tests with a single alias
  hop; `comesFrom` and `callsInto` already cover both transitively.

The long tail is the same shape at smaller stakes: `readName` at two
hops, `astResolve` at eight, three separate `.then`-chain walks, the
GraphQL fragment splice. The structural depth caps (`unwrap`, shape
extraction, path enumeration) are not on the list; they bound
recursion over one expression, not a relation.

### The same question, answered several ways

We found nine questions with more than one implementation. Four of them
matter:

- **What local name binds this import.** Seven copies:
  `resolveImport.ts`, and again inside `registrationCall`, `clientCall`,
  `registrationTemplate`, `graphqlHookCall`, `packageImport`, and the
  two decorator recognizers. The fact layer already emits
  `imports(x, m, n)` for every one of these.
- **What function does this expression refer to.** Six copies:
  `store.resolveCallable` plus five hand-rolled ones.
- **Where does this code run.** `unitScope.runsIn` is one predicate, but
  the path test is a callback each caller supplies, and the three
  callers supply three different tests: `file.startsWith(scopePath)` in
  `runtimeConfigPairing`, `file.startsWith(scopePath)` in
  `messageBusPairing`, and `file.includes(codeScope)` fifty lines
  further down the same file.
- **How a code path is normalised.** Six copies of `normalizeCodeUri`
  and friends, and they disagree on the trailing slash three ways. The
  CloudFormation runtime-config reader preserves a trailing slash on
  purpose, with a comment saying the prefix match needs it so `src/foo/`
  does not match `src/foobar/`. The CloudFormation message-bus reader
  appends one unconditionally, with a comment claiming it matches the
  first. The SAM manifest reader strips it. Two of the three feed the
  same `metadata.codeScope.path` field that the two `startsWith` calls
  read. The brief predicted three copies with different conventions;
  there are six.

### Where the thirteen pinned bugs live

`tools/differential/src/shape/knownBugs.ts` pins thirteen. They are not
one problem.

| pin | belongs to | kind |
| --- | --- | --- |
| `route: defaultOfName` | `namedExport` default-export pass reads syntax | resolve the value |
| `route: throughProperty` | same | resolve the value |
| `binding: destructured` | `facts/extract.ts` emits no `binds` for a destructuring pattern | missing base fact |
| `binding: withDefault` | same, for a default | missing base fact |
| `form: overloaded` | same, no `func` for an overloaded declaration | missing base fact |
| `route: barrel` | duplicate summary on one identity | dedup key |
| `route: defaultDeclaration` | a named function exported as default is named `default` | naming |
| `route: throughFactoryArg` | the deleted `unwrapsProperty` rule | blocked, ambiguity |
| `reach: throughFactoryArg` | same | blocked, ambiguity |
| `reach: throughCallReturn` | needs negation over a relation the asking rule derives | blocked, no stratification |
| `reach: throughParameter` | should be treated as a boundary with an unknown handler | not a rules question |
| `result: wideNamedType` | type expansion breadth | already addressed by refs |
| `method: arrowProperty` | `decoratedMethod` reads methods, not arrow properties | walker gap |

In five pins, the fact layer needs to be asked one more question or
given one more fact. Three are blocked and documented as blocked. Five
are something else entirely.

## Ranking

**1. Ask the store where discovery still reads syntax.** First kind.
`resolverMap.ts` works out "what object literal is this" three separate
ways by hand and is never handed the store at all; `registrationLoop`
and `registrationTemplate` each work it out a fourth and fifth way;
`namedExport`'s default-export pass reads the syntax at the position
while its two neighbouring passes ask. The evidence is that this exact
change, in three other places, took NestJS from 7 boundaries to 434 and
Express from 0 to 52, with nothing project-specific configured. The
imprecision costs a lost boundary rather than time, so it is the first
kind by the loss it causes rather than by wall clock. It deletes roughly
250 lines across four files, retires two pins and sets up three more.

**2. Emit the base facts that three pinned cases need.** First kind, and
the cheapest thing here. `binds` for a destructuring pattern and for a
binding with a default, and `func` for an overloaded declaration. No
new relations, no new rules, three more kinds of tuple from
`facts/extract.ts`. It retires three pins. The fuzzer is the measurement
and it already runs in CI.

**3. One path convention, and one place that owns it.** First kind, and
the largest measured harm on the list: 1,307 wrong findings in one run.
Six normalisers with three trailing-slash conventions, feeding two
`startsWith` calls and one `includes`. This is not a rules candidate.
`runsIn` already states the question; what is missing is that the path
test is a callback rather than part of the answer, so the convention
lives at three call sites instead of one. Fixing it takes a shared
helper and a fact on the summary, not a fixpoint.

**4. Retire the six one-hop import readers.** First kind, low risk. Every
one of the seven copies of "what local name binds this import" asks a
question `imports(x, m, n)` already answers, and each copy stops at a
different place: none of them follow a re-export. The cost is one seed
per recognizer per file, and the demand rewrite already prices that.

**5. Memoise `helperResolution`, and let it resolve through the store.**
First kind. It crosses function boundaries, scans the helper's whole
body with `getDescendantsOfKind`, walks parents upward per return, and
caches none of it. Ten handlers returning `json(...)` re-resolve `json`
and re-walk its guards ten times. `store.importedNamesOf` demonstrates
the caching pattern on the same kind of problem. The resolution half can
move now. The guard half cannot: `earlyReturnGuardsBefore` is literally
"a guard that was not true", with a three-valued unknown on top, and
that is negation.

**6. Class methods and arrow properties in `decoratedMethod`.** Walker
gap, one pin. The class decorator goes through the store and the method
decorators are matched by literal name, inside one file. This is not a
rules change; the walker should look at one more member kind and ask the
same question the class already asks.

**7. Reaching definitions over a scoped control-flow graph.** Worked out
below. It can move without negation if it stays scoped. The unscoped
version is the second kind and costs about 2M base tuples on the largest
public corpus.

**8. The checker's pairing passes.** Blocked. Seventeen of the twenty-six
files are built around negation, and the negations are not incidental:
they are the findings. `envVarUnprovided` is "no declaration for X".
`messageBusConsumerOrphan` is "no producer sends to X".
`deadConsumerBranch` is "the provider never produces status N".
Under today's resume flag a rule set like that re-derives from base
facts every wave. Worth recording separately: every negation site has
its own guard against negating over an incomplete domain, and there are
nine independent inventions of it, from `readHere.size === 0` in
`unusedFindings` to `anyDefaultShapeRead` in the relational pass to the
`disputed` file deletion in `unitsByFile`. That is one shared
concept with nine spellings, and it is a better first move on the
checker than rules are.

**Not on this list: `bodyShapesMatch`.** Two type references match when
their `name` strings are equal, with no module qualification and no
structural fallback. It is a four-line semantics bug in
`ir-core/typeShapeMatch.ts`, not traversal, and it should be fixed as a
bug rather than ranked here.

## The first step

Give `namedExport.ts` the store in its default-export pass, and give
`resolverMap.ts` the store at all.

**Facts emitted:** none new. Both files work on values in files the
store already extracts. What changes is that `wanted(x)` gains one seed
per default export the pack asks about, and one per resolver-map
argument.

**Rules consumed:** `wantedResolves` for the export, `wantedComesTo` and
`objectOf` for the resolver map. All of them exist.

**Imperative code deleted:** `resolverMap.resolveObjectLiteral`,
`resolverMap.resolverMapObject`, and `resolverMap.resolveSchemaSdl`,
about 120 lines, plus the symbol chase in `namedExport`'s third pass.
`resolveSchemaSdl` in particular is a hand-rolled `resolveWrittenValue`
right next to `graphqlShared`, which already asks the store the same
question.

**Expected cost in tuples:** one seed per asked-about export per file,
plus the magic bookkeeping the demand rewrite adds at roughly 2.8 per
seed. On a corpus where every default export is a function written out
at the export, the chain ends on the first fact and nothing widens. The
cost to watch is a default export that resolves to nothing, because the
wave walk then widens to the file's imports up to six hops and extracts
those files. `registrationCall.couldNameAFunction` is the existing
answer to that and the same gate belongs here.

**Expected cost in time:** the closest prior is #70's, which moved
Twenty's `nestjs-graphql` from 7 to 434 boundaries without a wall-clock
regression worth reporting, and the counter-prior is the export
identity work, which found 2,034 units and cost 3.4 times the clock.
Which one this resembles depends on how often the answer is null,
because a null answer is what pays for the widening. Measure on
twenty-front, where the resolution rules do run and derive 2.8% of what
they used to after the rewrite, and on saleor-storefront, where they
barely run at all.

**How to know it worked:** the fuzzer's `route` dimension loses
`defaultOfName` and `throughProperty`, and both promote into the sound
tier. Summaries stay byte identical on every corpus where discovery
finds the same units. Engine time and derived tuples per relation from
`--datalog-profile` on both corpora.

## The path engine, worked out

`paths/pathConditions.ts` enumerates every entry-to-terminal path and
gives each terminal the conjunction of conditions along it. It knows
the successor structure of a function body and throws it away. The
question is whether that can be facts.

**Path conditions themselves should not move.** The positive rule
anyone would write first is

    reaches(a, a).
    reaches(a, c)     :- reaches(a, b), succ(b, c).
    gatedBy(t, c, p)  :- guards(a, b, c, p), reaches(b, t).

and it answers a weaker question than the enumeration does. It gives
the conditions on *some* path to `t`, which cannot tell "under `a` and
not `b`" from "under not `a`". Transition identity is built from the
conjunction, so that distinction is exactly what the summaries record.
Recovering per-path conjunctions in Datalog needs either a path-valued
term, which the engine does not have, or "no other condition
intervenes", which is negation. The enumeration is the right form for
what it produces, and the way it degrades is already sound: a case it
declines gets its enclosure conditions plus one opaque conjunct rather
than a fabricated claim.

**Reaching definitions can move, and without negation, if it stays
scoped.** The textbook rule kills a definition with a negated literal.
The negation is removable by materialising the complement as a base
fact: `passes(n, v)` for "statement n does not write v". Then

    reachesDef(d, n) :- writes(d, v), succ(d, n).
    reachesDef(d, n) :- reachesDef(d, m), succ(m, n),
                        writes(d, v), passes(n, v).

is Horn all the way down, and the store can resume between waves.

The cost of that complement is `|statements| × |variables|` per
function, which is not affordable across a program. It becomes
affordable by restricting `v` to names written more than once, which is
the only case where the answer differs from what `binds` already says.
`facts/assignments.ts` computes that set today, and `endsHolding`
(#71) is the special case the adapter added rather than run a general
analysis. Reaching definitions over a scoped graph is what would let
`endsHolding` stop reporting nothing when control flow decides.

**The numbers.** Measured over this repo's adapter package, 99 files:
16,814 statements, 2,170 functions, 2,353 branch statements. That is
about 7.7 statements and 1.1 branches per function, and about 170
statements per file.

Scoped to functions with a reassigned name, at roughly 8 statements and
1 such name each, the complement plus the successor edges come to about
16 tuples per function. Extrapolating the per-file statement count to
twenty-server's 5,011 files gives on the order of 110,000 functions;
if one in twenty has a reassigned name, that is under 90,000 tuples.
Affordable, and the reassignment count is the number to measure rather
than assume.

Unscoped, the same extrapolation gives about 850,000 statements and
roughly 1.1M successor edges, so about 2M base tuples before a rule
runs, on the corpus where the resolution rules do not execute at all
today. `reaches` is a transitive closure over that, bounded per
function but with a tail that is quadratic in the largest function.
That is the second kind of change: it makes new findings possible, an
error swallowed here and rethrown two frames up, or a call that stopped
happening because its branch became unreachable, and it asks a question
nobody asks today. Nobody should commit to it on the strength of those
findings without measuring the closure on one large corpus first.

**What the negation fix would have to cost.** `canResume` reads a flag
computed over the whole rule set, so one negated literal anywhere
disables resume for every stratum. Strata below the lowest negated one
are monotone and could resume normally. Making resume per-stratum is a
change inside `runRules`, on the order of thirty lines, and it is worth
doing when a candidate that needs negation is otherwise ready. What it
has to beat is the 66-seconds-to-never run: a negated design has to come
back under the 16.3s the import-gate change bought on that corpus, and
that means the retract-and-rebuild has to stop firing on every wave.
Until something needs it, this stays unbuilt and the candidates above
stay positive.

## What should stay imperative

A one-shot structural walk with no recursion, whose answer nobody else
needs, is a walker and should stay one.

- **`terminals/jsx.ts`.** Mutually recursive over a tree, but the tree
  is the answer: the render node it builds is the output, not an
  intermediate anybody joins against. Rules would restate the recursion
  and gain nothing.
- **`terminals/throws.ts`.** Already a table from a throw statement to a
  terminal. It inspects one node and its arguments. The one thing it
  gets wrong, matching a constructor by text prefix so an aliased
  `HttpError` is missed, takes an `importedNamesOf` call to fix, not a
  rewrite.
- **`terminals/extract.ts`.** Configuration-driven mapping over an
  extraction context. No traversal to speak of.
- **`assembly.ts`.** Composition of four steps into branches, 271 lines,
  no recursion, one caller.
- **`paths/pathConditions.ts`.** Covered above. Its output is per-path
  conjunctions, and the enumeration is what produces them.
- **`checker/dedupe.ts` and the finding builders.** Grouping and prose.
  Worth one note: the dedupe key includes the whitespace-normalised
  English of the description, and every finding without a boundary
  shares one bucket. That is a bug to fix in place, not a candidate to
  move.
- **The checker's negative passes**, until resume is per-stratum.
- **Syntax normalization.** Peeling casts and parentheses, counting
  the application layers of one expression, reading a decorator's
  name. Rules never see syntax; this is the fact emitter's own step.
- **Ruby's method resolution order** (`ancestry.ts`). The closure is
  order-sensitive by the language's definition, so it stays imperative
  or becomes a rule with an explicit precedence column, and not
  before.

## The questions this has to answer

**Could smaller pieces compose to this?** The first step is two call
sites in two files, using relations that already exist. Nothing new is
minted. The second and fourth entries in the ranking are each one kind
of base fact.

**Does it reuse what exists?** `resolveCallable`, `resolveObject` and
`resolveWrittenValue` answer every question the first four entries ask.
The demand rewrite already prices the seeds.

**Does it widen shared vocabulary?** No knob reaches pack authors. The
path convention entry narrows vocabulary rather than widening it: six
normalisers become one.

**Is it over-designed?** The first step deletes more code than it adds.
The path-engine section recommends building nothing.

**Was it verified against code somebody actually wrote?** The evidence
is #70 on Twenty and Directus, #72 on one corpus, #54 on a production
monorepo, and the statement counts measured on this repo. The tuple
extrapolations to twenty-server are extrapolations and are labelled as
such; anyone acting on the unscoped CFG number should measure it.

**What does it not do?** It does not move the checker to rules, and it
says why. It does not fix `bodyShapesMatch`, the barrel duplicate, the
default-export naming, or the three pins that are blocked on
stratification and ambiguity. It does not build a control-flow graph.
It does not touch the evaluator.

## What the migration must handle

- **Negation stays unaffordable** until resume is per-stratum. The
  mount agreement policy ("two resolved prefixes that disagree mean no
  answer") is naturally negation-shaped, so the closure derives every
  mount path and the agreement policy stays a post-processing step
  over derived tuples, the way the flow pass ships `may*` variants
  instead of negating.
- **Recognition needs its facts before it runs.** Recognizers fire
  synchronously inside the extraction walk, so derived relations must
  exist when they ask. The store's demand-driven evaluation already
  covers this at the sites that ask today; the change is wiring, not
  pipeline surgery: hand the store to discovery the way
  `registrationTemplate` and `resolverMap` already take it.
- **Facts have no cache; summaries do.** Every run re-extracts facts
  from scratch, and the summary cache's dependency edges already come
  from the store's walk recording, on null answers included. A
  per-file fact cache is the enabler to measure, not assume: the
  store's memo plus `fullyExtracted` may already bound the cost
  within a run, and `--datalog-profile` decides whether persistence
  pays.
- **The single-answer discipline survives the move.** The store
  refuses two candidates rather than picking one; `functionTargetOf`
  takes the first that resolves. Migrated call sites adopt the
  store's refusal, and the differential fuzzer catches what that
  changes.

## Order, for 0.20.0

1. Done before this order was written: the three binding pins are out
   of the fuzzer's list.
2. Done (#697, #698). `settled` is one store ask; `packageImport`
   attribution asks `importOriginsOf`; `factoryTracking` is deleted;
   the `namespaceImport` and `throughLocalBinding` pins retired.
   What made it fast enough is worth keeping for every later step: a
   question with many seeds gets its own demand class, the smallest
   relation leads each join, and candidates that cannot answer are
   filtered before seeding. The chains themselves are closures with no
   depth bound, since a bound in a rule is the walker's disease in a
   new spelling; the cost of unbounded chains is an evaluation
   concern (dropping demand facts nulls the engine's resume marks, so
   each batch re-derives), and the optimization pass at the end of the
   order addresses it in the engine rather than the rules. Measured
   with bounded chains: dogfood within eight percent of the
   pre-change wall time, 28 more consumers paired; re-measure after
   the bound's removal.
3. Done before this order was written: the default-export pass asks
   the store at every site, and the two route pins are retired.
4. Done (#701, #702, #703). The emitter states one file's own export
   syntax, the `moduleExport` rules flatten chains of any length
   behind a `wantedExportsOf` question, and `exportedDeclarationsOf`
   is one line over the store, with the warming walk and its overflow
   fallback deleted. `resolveAliasedSymbol` keeps its own warming
   until step 7. The behaviour gates caught what unit tests could
   not, and each catch is a rule the design now states: a
   parameter-rooted name stays a reference for the checker, because
   discovery filling the shared store lets one caller's argument
   settle what used to stay symbolic by accident of extraction scope;
   `export default x` goes through the local declaration but is left
   unstated when the name is written again, since the default takes
   the value where the statement runs, not the live binding a list
   exports; and the emitter descends into `declare module` blocks and
   asks the compiler to resolve specifiers ts-morph has not loaded,
   because a dependency's declaration file only ever entered the
   project as a side effect of the checker walk.
5. Done before this order was written (#78). `codeScopePath` and
   `fileInCodeScope` in `@suss/ir-core` own the convention, the three
   callback sites read them, and route comparison shares
   `normalizePath` and `boundaryKey` from the same package.
6. Python mount facts plus the shared `mountPath` closure, which
   finishes #251 and unlocks #689.
7. The seven import readers, retired against `imports`, and the
   one-hop origin predicates against `comesFrom`.
8. The `ReceiverOrigin` members as `comesFrom` queries (#542). The
   recognize ops surface shrinks with them.
9. Ruby and Python storage closures as rules, the first parity test
   for the claim that layers above facts come along unchanged.
10. Memoise `helperResolution` and resolve its callee through the
    store, leaving the guard evaluation where it is.
11. Measure the reassigned-name count on one large corpus. That
    number decides whether scoped reaching definitions is worth
    writing.

Each step ships behind the existing gates: summaries byte-identical
where discovery finds the same units, the fuzzer's pinned bugs as the
retirement list, dogfood counts, and engine time from the profile.
