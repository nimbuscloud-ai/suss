# Why a behavioral layer at all

Every codebase has a question at its heart: *what does this code do under what conditions?* Every nontrivial engineering task — debugging, reviewing, extending, onboarding, integrating — ends up trying to answer some version of it.

Over time, we've made parts of that question cheaper to answer:

- Compilation removed "do the shapes line up" from human attention.
- Unit tests made "does this specific case work" machine-answerable — at the time, writing more code to verify the code you just wrote seemed absurd. It became a given.
- CI removed "did anyone actually run the tests" from the question list.
- Types pushed shape-checking deeper into the code itself.
- Static analysis made classes of bugs visible without executing anything.

Each step moved questions from *need a human to read and think* into *derivable from the code*. Each was strange until it was normal, and then its absence was the new strangeness.

## The layer that's still missing

The conditional structure of what the code produces — *which cases, under what predicates, with what effects* — is still something every engineer reconstructs by hand.

- Types describe `User | null` without saying *when* `null`.
- Tests verify specific cases without enumerating them.
- OpenAPI, GraphQL SDL, ts-rest `responses` declare intent and drift.
- Observability reports what happened, after it happened.
- Contract tests (Pact and similar) record agreed examples, not full case sets.

Nobody writes the conditional structure down by hand at scale because hand-authoring it is intractable. Every engineer holds a partial mental model; every review reconstructs it; every onboarding rebuilds it from source; every AI agent interaction pays for the reconstruction in tokens. None of that effort is captured or reused.

suss derives it. One structured description per code unit — the transitions it produces, the predicates that gate each, the effects that fire, the outputs returned — comparable across files, diffable across commits, pairable across boundaries, same shape whether the unit is an HTTP handler, a React component, a GraphQL resolver, an internal library function, or a stub generated from an OpenAPI spec. The summary stays in sync with the source by construction.

## What having the layer in place enables

- **Behavioral diffs on pull requests** — not *forty lines changed*, but *one 404 case removed, one throw path added, one condition inverted*.
- **Cross-boundary checking** — does the caller at this site actually handle every status the provider produces? Machine-answerable, before anything runs.
- **Contract consistency** — the spec says X; the code does Y; the disagreement becomes a finding rather than a runtime surprise.
- **Publishing** — ship `dist/suss-summaries.json` with your package. Downstream teams verify against your actual behavior, not the README.
- **Cross-codebase reasoning for AI agents** — a twenty-service monorepo's behavior fits in a few hundred KB of summaries; its source doesn't fit in any context window. Agents aren't *unable* to read source — reading source costs tokens, time, and consistency run-to-run. Summaries are the compact, verifiable index; source is the fallback when the agent needs to confirm a specific detail. The same substrate also supports *verifying* an agent's claims: if it asserts "X returns 404 only when the user is missing" and the summary says otherwise, the disagreement is observable.

## Alongside what you already use

None of the existing layers go away. Each approximates derived behavior from a different angle:

- **Tests** verify specific examples; summaries describe the case set those examples sample from.
- **Types** describe shape; summaries describe *when* each shape is produced.
- **Schemas and specs** declare the interface; summaries derive reality and let you compare automatically.
- **Linters** match syntactic patterns; summaries operate at the branch level, framework-aware.
- **Observability** shows what happened; summaries show what can happen, before it does.
- **Contract tests** capture agreed examples; summaries capture the full enumeration, without hand-authoring.

Summaries are the derived-behavior layer each of those approximates. Keeping them separate is the point: different shapes of truth, compared against each other, catch different failures. See [Three kinds of truth](/contracts).

## Where this goes

**Today.** HTTP, React, GraphQL, in-process function calls. Coverage is schema-shaped — status codes, response bodies, call signatures, conditional rendering, resolver arg shapes.

**Near-term.** More transports (queues, events, RPC), deeper subject tracing, closing gaps where current summaries fall back to opaque. Re-throw resolution, module-level state capture, closed-over identifier chains.

**Further.** Cross-shape contract agreement — inferred behavior checked against specs, tests, snapshots, design artifacts, and observations at the same boundary. The first domain where this matters materially is React (see [React roadmap](/internal/roadmap-react)); the template generalizes. A schema that says "this endpoint returns 200 or 404" is one shape of truth; a Playwright test that exercises the 200 path is another; a Storybook story capturing the empty-state render is a third; observed traces in production are a fourth. Pairwise, they're already useful. All of them compared against the derived truth of what the code actually does — that's what the layer unlocks.

**Furthest.** Intent specifications as first-class, comparable artifacts; sync-chain composition into named features; audience-indexed summaries ("what's visible to *which* role?"); observation adapters feeding production traces back into the same substrate. The Jackson-grounded arc tracked in [the forward-looking backlog](/internal/backlog) and grounded theoretically in [concept design](/internal/concept-design). The behavioral summary is the foundation those layers ride on top of.

The pattern at every step is the same one unit tests established: make something that used to require human reading into something a tool can derive, compare, and act on. Behavioral structure is the next layer in that arc.
