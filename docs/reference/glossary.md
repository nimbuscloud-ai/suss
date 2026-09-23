---
title: Glossary
description: One definition each for boundary, summary, code unit, terminal, pack, and the rest of the vocabulary these docs use.
---

# Glossary

**Boundary**, a place where two pieces of code meet across a contract. A REST endpoint, a GraphQL operation, a queue, a database table, a package export, an environment variable, a React parent rendering a child. One side is the *provider*, which produces the value, and the other is the *consumer*, which acts on it. They can be in the same process.

**[Boundary binding](/reference/ir#boundarybinding)**, the value on a summary that identifies which boundary the unit is on. It has three parts: the *transport* the bytes move over (`http`, `in-process`), the *semantics* that give the boundary its pairing rule (`rest`, `storage`, `message-bus`, and six more), and the *recognition* that records which pack found the unit. The pairing layer reads it to decide which summaries to compare. See [Boundary semantics](/theory/boundary-semantics).

**Summary / [`BehavioralSummary`](/reference/ir#behavioralsummary)**, the description suss writes for one code unit: its transitions, the conditions gating each, what each produces, the effects it causes, and the gaps. It is JSON, and nothing in it identifies the language or framework it came from. Checking, inspection and every downstream tool read summaries.

**Code unit**, one callable piece of code: a handler, a loader, a component, a resolver, a queue consumer, a library function. Every code unit has a **kind** ([`CodeUnitKind`](/reference/ir#codeunitkind)). How inputs arrive and what counts as output depend on the kind.

**Terminal**, a place in a code unit that produces something observable. A `return`, `res.status(400).json(...)` in Express, a `throw` through a project's own error helper, a JSX return in a React component.

**[Transition](/reference/ir#transition)**, one execution path: the conditions that have to hold, the output that comes out, and the effects that fire, under a stable `id`. A unit's behavior is its set of transitions, and checking compares them one against another.

**[Predicate](/reference/ir#predicate)**, one condition gating a transition. It has a **subject** (the value being tested) and a test (nullness, equality, and so on), and predicates compose into `and`, `or` and `negation`. `!user` becomes a `truthinessCheck` against the result of `db.findById`, with `negated: true`. An expression the reader cannot take apart becomes an `opaque` predicate keeping the source text. Predicates are structural, so the same condition written two ways on two sides of a boundary still compares.

**Subject / [`ValueRef`](/reference/ir#valueref)**, a reference to a value: where it came from (a parameter, a call, a literal, component state) and the property chain from there to the value being tested. It identifies the value without interpreting it.

**[Output](/reference/ir#output)**, what a terminal produces. One of `response`, `throw`, `render`, `return`, `delegate`, `emit` or `void`.

**[Effect](/reference/ir#effect)**, something observable a unit causes while it runs: a database write, a message on a queue, scheduled work, a config read, a call to another service. Two functions that return the same value and touch different stores do not agree.

**[Gap](/reference/ir#gap)**, something the summary could not account for. suss records it in the summary and the run keeps going. An `unhandledCase` gap marks a hole in the code: the contract declares a 500 the handler never produces, or the handler produces a status the contract leaves out. An `unreadOutcome` gap marks a piece of code suss could not read, such as a `return` that didn't match any of the terminal shapes the pack looks for. An `unfollowedCall` gap records a call the walk could not resolve to a body.

**Declared contract**, a machine-readable statement of behavior written beside the implementation: a ts-rest router, an OpenAPI document, a GraphQL schema, a Prisma schema, a Storybook story. suss reads both the declaration and the code, and the checker compares them. See [Kinds of contract](/why/kinds-of-contract).

**Contract source**, a contract somebody wrote at the boundary itself: an OpenAPI YAML, a CloudFormation template, a Terraform file, a hand-written stub. `suss contract` turns one into the same summaries the extractor writes, and what comes out is marked `confidence.source: "derived"`. See [Contract sources](/packs/contract-sources).

**[Finding](/reference/ir#finding)**, a record that two paired summaries disagree. It has a `kind`, a `severity` (`error`, `warning` or `info`), the boundary, both sides, and a sentence saying what is wrong. The [findings catalog](/reference/findings) lists every kind. The behavioral checker emits `Finding`; the intent checker emits `IntentFinding`, which has a document on one side instead of a second piece of code.

**Pack**, a set of declarative patterns (a `PatternPack`) that the adapter and the extractor use to recognize a framework, a runtime or a library. A pack is a data object. See [What a pack is](/packs/what-a-pack-is).

**Recognizer**, a rule in a pack that fires when the extractor meets a particular call or property access, such as `setTimeout(...)` or `process.env.X`. It attaches an effect or some metadata to whichever unit it fired inside.

**Sub-unit**, a code unit a pack declares inside another, such as a callback passed to `setTimeout` or a React event handler inside a component. A sub-unit gets its own summary. Everywhere else the walker descends into nested functions and puts their behavior on the enclosing unit.

**[Confidence](/reference/ir#confidenceinfo)**, how much of a unit's behavior suss read, as `high`, `medium` or `low`. A return the pack could not read makes it `low` on its own; otherwise it is the share of predicates that came out opaque. The checker does not change a finding's severity because of it. A `confidence.source` field records where the summary came from, extracted code or a contract source.

**Intent doc**, a statement your team writes of what a boundary should do (`*.intent.yaml`) or what should happen for the person using it (`*.prd.yaml`). It parses to `IntentSummary` and `@suss/checker-intent` pairs it against the code. See [Check against your intent](/guides/check-against-intent).

**Suppression**, a `.sussignore` rule that marks, downgrades or hides a finding you have accepted, without touching the summaries. It works on behavioral and intent findings alike. See [Accept a finding](/guides/accept-a-finding).

**Epistemic character**, what kind of truth a contract asserts: a *specification* says what should happen, an *observation* says what happened once, and a *derivation* says what the code does on every path. The findings that matter are the ones that cross two of these. See [Kinds of contract](/why/kinds-of-contract).
