# Glossary

One canonical definition per term. Other docs link here rather than redefining. The running example throughout is a `getUser` handler for `GET /users/:id`.

**Boundary**, a point where two units of code meet across a contract: a REST endpoint, a GraphQL operation, a queue topic, a package export, an env-var read, a React parent rendering a child. Boundaries are where behavioral contracts matter and where drift shows up. Every boundary has a *provider* side (produces output) and a *consumer* side (acts on it), even when both live in the same process. For `getUser`, the boundary is `GET /users/:id`.

**[Boundary binding](/ir-reference#boundarybinding)**, the `BoundaryBinding` value attached to every summary that identifies its boundary. It separates *transport* (where bytes move: http, in-process, graphql), *semantics* (the discriminated union that gives the boundary its pairing rule: rest, function-call, graphql-resolver), and *recognition* (how the adapter found the unit). The pairing layer reads it to decide which summaries compare. See [Boundary semantics](/boundary-semantics).

**Summary / [`BehavioralSummary`](/ir-reference#behavioralsummary)**, the structured description suss derives per code unit: its transitions, the predicates gating each, the outputs, the effects, and any gaps. Language- and framework-agnostic JSON. The summary is the product; checking, inspection, and downstream tooling all consume it.

**Code unit**, a callable piece of code (handler, loader, component, resolver, consumer, library function). The atomic unit of analysis. Every code unit has a **kind** ([`CodeUnitKind`](/ir-reference#codeunitkind)) that determines its behavioral model. `getUser` is a code unit of kind `"handler"`.

**Terminal**, a point in a code unit where observable output is produced. Each `return` in `getUser` is a terminal; other shapes are `res.status(400).json(...)` in Express, `throw widgetError(404)` through a project's own error helper, a JSX return in a React component.

**[Transition](/ir-reference#transition)**, `(conditions → output, effects)` with a stable `id`. The atomic unit of behavioral description; a code unit's full behavior is its set of transitions. Matching between boundaries happens at the transition level.

**[Predicate](/ir-reference#predicate)**, a structured condition gating a transition. Has a **subject** (what value is tested), a **test** (nullness, equality, etc.), and composes into `and` / `or` / `negation`. The source expression `!user` becomes a `truthinessCheck` predicate against the subject `db.findById`'s result, with `negated: true`. When the extractor can't decompose an expression, it falls back to an `opaque` predicate that preserves the source text. Predicates are structural, not textual, so the same concept is comparable across a boundary where it appears in different forms.

**Subject / [`ValueRef`](/ir-reference#valueref)**, a reference to a value with an *origin* (parameter, dependency call, import, context) and a *path* (property access chain). Shallow on purpose: it identifies what's being tested without trying to understand its full semantics. Two predicates that test the same subject, on different sides of a boundary, are recognizable as referring to the same thing.

**[Output](/ir-reference#output)**, what a terminal produces. One of `response`, `throw`, `render`, `return`, `delegate`, `emit`, or `void`.

**[Effect](/ir-reference#effect)**, an observable side effect a code unit causes during execution: a database write, a queue message, scheduled work, a config read, a call to another service. Effects are part of the output alongside the terminal value, two implementations that return the same shape but cause different side effects don't agree.

**[Gap](/ir-reference#gap)**, something the summary could not account for. Recorded in the summary, not raised as an error. An `unhandledCase` gap is about the code: the contract says the endpoint can return 500 and the handler never produces one, or the handler returns a status the contract didn't list. An `unreadOutcome` gap is about the reading: a `return` matched none of the terminal shapes the pack looks for. The checker reports the first as a contract violation at error severity and the second at info, since the handler may be answering correctly in a shape nobody taught the pack.

**Declared contract**, a machine-readable behavioral declaration authored alongside the implementation: a ts-rest router, an OpenAPI document, a GraphQL SDL, a Prisma schema, a Storybook story. The extractor reads both the declaration and the implementation, and the checker compares them. See [Contracts](/contracts) for how declared contracts relate to derived and observed truth.

**Contract source**, a behavioral contract authored at the boundary rather than extracted from implementation (an OpenAPI YAML, a CloudFormation template, a vendor's documented behavior, a hand-written file). Contract sources produce the same `BehavioralSummary[]` as the extractor and feed the same checker, carrying `confidence.source: "derived"`. See [Contract sources](/contract-sources).

**[Finding](/ir-reference#finding)**, a structured record that two paired summaries disagree at a boundary. Carries a `kind`, a `severity` (`error` / `warning` / `info`), the boundary, both sides, and a description. The [findings catalog](/reference/findings) enumerates every kind. The behavioral checker emits `Finding`; the intent checker emits `IntentFinding` (one-sided coverage rather than a two-sided peer comparison).

**Pack**, declarative patterns (a `PatternPack`) the adapter and extractor consume to recognize a framework, runtime, or library. Packs come in four kinds, framework, client, runtime, contract, and are data, not code. See [Packs](/packs).

**Recognizer**, a pack-declared rule that fires when the extractor encounters a specific call or property access (`setTimeout(...)`, `process.env.X`, `__dirname`). Recognizers attach effects or other metadata to whichever code unit they fire inside.

**Sub-unit**, a code unit a pack declares inside another (a callback passed to `setTimeout`, a React event handler inside a component). A sub-unit's behavior lands on its own summary; the walker otherwise descends into nested arrows and function expressions and attributes their behavior to the enclosing unit.

**[Confidence](/ir-reference#confidenceinfo)**, how much of a code unit's behavior was read, bucketed into `high` / `medium` / `low`. A return the pack could not read makes it `low` on its own; otherwise it is the ratio of opaque predicates to total. Informational: the checker doesn't downgrade finding severities from it. A `confidence.source` field records where the summary came from (extracted code vs. a contract source).

**Intent doc**, a team-authored statement of what a boundary *should* do (`*.intent` / system intent) or what should happen for the user (`*.prd` / outcome intent). Intent parses to `IntentSummary`, its own artifact stream, and is paired against derived code by `@suss/checker-intent`. See the [intent section of Contracts](/contracts#intent).

**Suppression**, a `.sussignore` rule that marks, downgrades, or hides an accepted finding without changing the summaries. Applies to both behavioral and intent findings. See [Suppressions](/suppressions).

**Epistemic character**, what kind of truth a contract shape asserts: *specification* (what should happen), *observation* (what happened once), or *derivation* (what the code does across all paths). The interesting findings are cross-character. See [Contracts](/contracts).
