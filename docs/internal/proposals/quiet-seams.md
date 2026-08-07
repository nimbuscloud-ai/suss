# Proposal: three seams where extraction goes quiet

Status: draft, seeking alignment. One fix landed (the bootstrap gate);
the rest is unimplemented.

## The problem

Running the full pipeline against a production serverless monorepo
turned up four failures. Three of them share a cause, and it is not the
one the symptoms suggest.

1. `suss extract -p tsconfig.json -f aws-lambda` wrote zero summaries
   and exited 0. Every pack that discovers through a callback was
   affected, which is every AWS pack.
2. Every extracted status code and body came back swapped, at
   `confidence: high`, with no gap. The project builds its response
   envelope through a local helper, and the pack assumed an argument
   order for it rather than reading the helper. It assumed the wrong
   one.
3. Pairing the template-declared routes against the extracted handlers
   reported `Paired 0 provider-consumer combinations` and `No findings`,
   and exited 0.
4. The Apollo pack found only a handful of GraphQL call sites. Almost
   every call in that frontend goes through one local hook wrapping the
   Apollo hook, and the pack looks for the library call itself.

Number 1 was a stale duplicate of a predicate and is fixed. The
remaining three are covered here, along with the part of 4 that shares
a mechanism with 2.

## What they have in common

Each is a point where a stage meets something it cannot resolve and
produces nothing, without recording that it produced nothing.

The project already has a rule for this. Degradation is explicit,
nothing is silently skipped, checkers report what was checked and what
was not rather than only what was found. The rule is enforced inside
the extractor: opaque predicates keep their source text, `detectGaps`
runs both directions, the Lambda pack emits `recognized-not-http` units
so a declared handler is never dropped without a record.

It is not enforced at the seams between stages. Bootstrap to discovery,
terminal to helper, pairing to checker. At each of those, one stage
returns an empty result and the next cannot tell "there was nothing
there" from "I could not look."

For a tool whose output is a report about someone's code, that is the
failure mode with the highest cost. A crash gets reported. An
error-free report gets believed.

## Part 1: extraction diagnostics

### Where the accounting lives

The CLI could work out why extraction returned nothing: re-read the
tsconfig, re-check the gates, report. That means a second copy of the
pre-filter's logic. A second copy of that logic drifting from the first
is what caused failure 1, where `lazyProjectInit.ts` carried an
outdated `packIsUngated`. So the accounting is produced by the pipeline
and carried out to the CLI.

The seam already exists. `TypeScriptAdapterConfig` has `onTiming` and
`onCacheDiagnostic`, each a per-run report the adapter fills and the
CLI renders. A third of the same shape adds no new concept.

### What it records

The question "why zero" is always "at which stage did the count reach
zero", so the report is a funnel:

| Stage | Recorded |
|---|---|
| tsconfig | files in the include set |
| pre-filter | candidates per pack, and the gate specifier that selected them |
| gate resolution | whether each gate specifier resolves from this tsconfig |
| discovery | units found per pack |
| terminals | units that produced no terminal |
| accounting | units dropped on purpose, with the reason |

The gate-resolution row is the one worth designing rather than
inheriting. "The gate matched no files" and "the gate matched files but
the module does not resolve" are different problems with different
fixes, and today both present as zero. One `ts.resolveModuleName` call
per gate separates them, and turns the Apollo case from silence into a
sentence: the `@apollo/client` gate matched files, the specifier does
not resolve from this tsconfig, install dependencies. That covers the
undocumented prerequisite that packs relying on symbol resolution need
the target's dependencies installed while packs relying on textual
gates do not.

### Rendering

Quiet on the happy path. When the summary count is zero, print the
funnel and name the stage where it reached zero. `--explain` prints it
always. `--fail-on-empty` gives CI a gate, since a project may
legitimately have no boundaries and the default exit code should not
assume otherwise.

Structure the report as data with a rendering on top rather than as a
printed string. Other consumers want it.

## Part 2: helper resolution

### Why the pack was able to guess

Discovery patterns can bind to an import. `DiscoveryPattern` carries
`requiresImport`, and a match like `graphqlHookCall` carries
`importModule`, so discovery can say "only if this came from the
library."

Terminal patterns cannot. The vocabulary is

```ts
| { type: "functionCall"; functionName: string }
```

and the matcher compares `callee.getText()` against that string. No
symbol resolution, no origin. So a pack that wants to recognize a
library's response helper has no way to say so, and the pattern it can
write matches any identically named function in the user's project.

The pack contributed too. Its comment records the decision: for a
same-module helper it "declares the envelope its name implies rather
than resolving the helper body." It knew it was matching project-local
code and encoded an argument order anyway.

The vocabulary gap made the failure possible. The pack decision made it
certain. Fixing only the pack leaves the next pack free to repeat it.

### Two changes, doing different jobs

**Origin binding on terminal matches.** Add the same import binding
terminals already lack and discovery already has. A pack can then say
"the library's own `json`", and a same-named local helper stops
matching.

On its own this yields zero terminals where it previously yielded
inverted ones. Better, because silence beats a wrong answer, and not
sufficient.

**Resolution through in-project callees.** When a return expression
calls a function defined in the project, resolve the declaration, bind
its parameters to the call's arguments, and run terminal matching
inside the helper with that binding. The pack's existing
`{ statusCode, body }` object-literal pattern then matches on the
helper's return, and `statusCode` resolves back through the parameter
binding to whichever argument the caller passed. Both argument orders
work and the pack encodes neither.

Parameter defaults come along for free. A call written
`redirect(url, cookie)` against a declaration written
`function redirect(location, cookie?, status = 302)` resolves to 302,
which the positional guess gets wrong today.

This is the staging decision 5 already commits to: in-project resolves
to full extraction, typed dependencies to type information, untyped to
opaque. The terminal layer is the one place that skips it.

### The minimum bar if resolution slips

When the callee is defined in the project and resolution fails, emit a
gap rather than a value. Wrong at high confidence is the only outcome
here worse than saying nothing. This is a small change and should land
first regardless of when resolution does.

### Inline resolution or units

The helpers are already extracted. `includeReachable` defaults to true,
so every function reachable from a discovered unit becomes a
`library`-kind summary. In the run above, 35 of the 42 summaries suss
wrote were these, and the response helper was among them. Nothing
consumes them.

So "resolve the helper" has two possible shapes:

**Inline.** Walk to the declaration at each call site and extract from
there, the way `astResolve.ts` already resolves shapes through
identifiers, destructurings, and single-return calls.

**By reference.** The caller's terminal names the helper's unit, and
assembly inlines that unit's transitions with arguments bound to
parameters.

By reference is better in the long run:

- One extraction per helper rather than one per call site. When a
  codebase funnels hundreds of call sites through a single wrapper,
  that difference is the budget.
- Helpers calling helpers work by the same mechanism, with no hop
  limit to tune.
- A helper in another workspace package is already a unit if that
  package was extracted. Inline resolution needs the file in the same
  ts-morph project.
- It is where transitive recognition has to live. If a unit carries a
  boundary binding, a caller that inlines it can inherit that binding,
  which is the answer to the local-wrapper case. Inline resolution has
  nowhere to put that.

It also carries the risk: a four-branch helper inlined at twenty call
sites is eighty transitions. That needs a rule, something like inline
when the helper's returns are envelopes the pack recognizes, keep a
reference otherwise.

**Build inline first**, because it is smaller and unblocks the terminal
case. Shape it so the resolution step returns a memoized reference to a
declaration rather than a raw `TypeShape`. A memo keyed on declaration
node is one step from a unit registry, which makes the by-reference
version an extension rather than a rewrite.

## Part 3: the conformance axis

### Why both sides were providers

`pairSummaries` buckets on one axis, `BOUNDARY_ROLE[kind]`. The
template summary and the handler summary are both `kind: "handler"`, so
both are providers, so neither has a counterpart.

`contracts.md` names a second axis and treats it as the organizing idea
of the document: specification against derivation against observation.
Pairing does not read it. So two summaries that agree on boundary key
and role but differ in character have no relationship pairing can
express, even though the document says what their relationship is and
what severity a disagreement carries.

### Step zero: the character field does not exist yet

The axis is in the design. The field that should carry it is
overloaded:

```ts
ConfidenceSource = "inferred_static" | "inferred_ai" | "declared" | "derived"
```

The CloudFormation reader tags template-read routes `derived`. Code
summaries carry `inferred_static`. `contracts.md` uses "derivation" for
the code side. `checkContractConsistency` uses `provenance === "derived"`
to mean "produced by the same source as the transitions, so comparing
them is tautological."

Three meanings, one word, and one of them is close to the opposite of
another. Dispatching on this as it stands produces a checker that is
confident about which side is the specification and wrong. Settle it
first: either add a separate `character` field, or correct the
taxonomy and update the readers.

### The three relationships

Group by boundary key, then classify each summary by role and
character:

```ts
type Relation =
  | { kind: "peer";        provider; consumer }        // checkPair, today
  | { kind: "conformance"; specification; derivation } // missing
  | { kind: "reconcile";   a; b };                     // contractDisagreement
```

Worked example, an OpenAPI file beside an Express app:

```
key: (POST, /users)
  POST /users     provider  specification  (openapi reader)
  createUser      provider  derivation     (express pack)
  useCreateUser   consumer  derivation     (fetch pack)
```

Three comparisons from one group. Does the handler do what the spec
declares. Does the client agree with the handler (ships today). Does
the client handle what the spec declares. None of them require the
packs to know about each other.

Two specifications on one key are the third kind. `contractDisagreement`
already exists as a finding kind and nothing produces it on this path.

### Why this rather than attaching contracts at extraction

The alternative is to have the pack attach the declared contract to the
code summary, the way ts-rest lifts `responses` into
`metadata.http.declaredContract`. The Lambda pack already parses the
template, so it could. That ships fastest and needs no new machinery.

It works only where one pack owns both sides. An OpenAPI spec beside an
Express app cannot be attached by the Express pack, which has no idea
the spec exists. And it leaves `suss contract --from <source>` emitting
summaries with nowhere to go, which is the state that produced
`Paired 0` in the first place. Seven contract readers sit in that
position for the same reason.

### Staging

Classification and the conformance bucket first, before the comparison
is built out. Pairing alone converts "No findings, exit 0" into "7
boundaries have both a declared route and an implementation, here is
what was compared against what." That is the accounting rule again,
which is the thread through all three parts.

## Sequence

1. **Extraction diagnostics.** Hours of work. First, because no result
   from the other two is trustworthy while silence stays ambiguous.
2. **Gap on unresolved in-project helpers.** Small. Stops the
   wrong-at-high-confidence output before the resolution work lands.
3. **Origin binding on terminal matches.** Stops packs asserting
   conventions over user code.
4. **Inline helper resolution.** The primitive item 6 needs.
5. **Character field, then the conformance axis.**
6. **Transitive recognition on the discovery side.** The wrapper case.
   Largest of these, and it should reuse item 4's resolution primitive
   rather than growing a second one.

## Open questions

- Several specifications and several derivations sharing one key
  produces an N by M set of conformance relations. Cap it, pick one, or
  report all?
- Does the funnel report belong on the adapter config alongside
  `onTiming`, or should the three diagnostic callbacks collapse into one
  `ExtractionReport`?
- Should `--fail-on-empty` be the default in CI configurations we
  document, given that a silent zero is the failure this whole proposal
  is about?
