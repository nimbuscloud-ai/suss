# Open source and product, revised

Where the line sits between what ships open and what the company
sells, what the July run against a production monorepo changed about
that, and what the resulting design has to account for.

## The split still holds

Single-repo, single-moment primitives ship open. Cross-repo, temporal,
and org-level features are product. Nothing in the recent work argues
against it.

**Open source.** Extraction produces behavioral summaries from a
codebase. Contract readers turn schemas and templates into the same
shape. Checkers compare a pair at a moment: contract consistency,
GraphQL agreement, message-bus pairing, storage access, env-var
config, intent coverage. This is already well past printing findings
to stdout, and the product should not be positioned as the version
that works.

**Product.** Summaries from every service in an organization, held as
one graph over time. The handler in service A changed its behavior in
Tuesday's deploy and three consumers in B, C, and D have not caught
up. History, correlation, alerting, workflow integration, and the
context layer that agents query.

## Four amendments

### The adoption physics are not Sentry's

Sentry's SDK works because instrumentation happens at runtime and is
universal. You import it, errors flow, and nothing about that depends
on how your team writes code.

Suss produces its data by static analysis that has to recognize how a
team expresses its boundaries. The July run is the counterexample. A
team that wraps Apollo in one local hook and calls that hook everywhere
gets almost nothing from the Apollo pack, which looks for the library
call itself; suss saw only the handful of call sites that still reached
Apollo directly. A team that builds its Lambda response envelope
through a local helper gets whatever argument order the pack guessed,
and the pack guessed wrong, so every extracted status and body came
back inverted at high confidence. Neither pattern is unusual.

So the on-ramp is not three lines and no configuration. It is "does a
pack recognize the way your team writes code." That is the largest
threat to the funnel argument, because the whole model rests on data
production being cheap.

### The moat is the pack corpus, not the aggregation

If recognizing production code is the hard part, then accumulated
knowledge of how codebases express boundaries is the asset that
compounds, and it is harder to copy than an ingestion pipeline.

That implies a loop the Sentry framing does not have. Sentry's SDK
does not improve because Sentry's backend saw your errors. Suss's
extraction would. The design for it is below, because getting it right
early is worth more than getting the graph right early.

### Self-hosting is a requirement, not an objection

Sentry ingests runtime error events, which teams already accept
shipping off-box. A behavioral summary is derived from source: function
names, file paths, response shapes, branch conditions. It is closer to
shipping a code index than to shipping error events, and enterprise
buyers will treat it that way.

This does not break the model. It moves VPC and on-premises deployment
and summary redaction from later concerns into requirements, and it
argues against assuming the hosted version is the only one anyone
wants.

### The intent layer moved the center of gravity

The earlier framing was built around drift between services over time,
which is a graph and history product. The wedge the strategy review
landed on is intent-to-code verification for generated code, which is
a per-change gate that lives in the pull request.

Both can be true. They are different products with different first
builds, and the gate is much cheaper to ship than the living graph.
Sequence the gate first and let the graph be what it grows into.

## Designing the recognition loop

The claim is that extraction gets better because the product saw what
it failed to recognize. That only works if three things are true: the
failure is captured, it can leave the customer's network, and it lands
somewhere that turns it into a pack.

### What the signal is

Most of it already exists in the IR, produced for other reasons:

- **Confidence levels.** A summary or transition that came back `low`
  marks a place where extraction reached for something and did not get
  it.
- **Gaps.** `detectGaps` runs both directions and records declared
  outcomes never produced and produced outcomes never declared.
- **Opaque predicates.** Every condition that failed to decompose
  preserves its source text and a reason.
- **Accounting units.** The Lambda pack emits `recognized-not-http`
  units so a handler the template declares is never dropped without a
  record.
- **Unmatched buckets.** Pairing already separates providers with no
  counterpart from summaries with no binding at all.

The one missing piece is the extraction funnel: files in the include
set, candidates surviving each pack's import gate, units discovered,
units with no terminals. That is the diagnostics work already queued,
and it is the part that captures total failure rather than partial
failure. Note what that means for sequencing: the diagnostics item is
not only a usability fix, it is the sensor the whole loop depends on.

### Fingerprints, not code

The report cannot carry source. An organization that will not ship
summaries certainly will not ship the code that failed to parse, and
that constraint is where the Sentry model would otherwise break.

So the unit of feedback is a structural fingerprint: the shape of the
thing that was not recognized, with every identifier, literal, and path
removed. The response-helper case becomes something like

    unrecognized: call in return position
      callee: local function, same module
      callee returns: object literal
      callee return keys: [statusCode, body, headers]
      call arity: 2
      pack active: aws-lambda
      pattern that half-matched: terminals.functionCall

and the wrapper case becomes

    unrecognized: exported function, called from many sites
      body calls: hook imported from @apollo/client
      pack active: apollo-client
      gate matched: yes
      units discovered: 0

Neither carries a function name, a file path, or a business term. Two
properties follow, and both matter more than the privacy framing
suggests:

1. **It is aggregatable.** Fingerprints from different organizations
   collide when the underlying pattern is the same, which is what turns
   a pile of individual failures into a ranked list.
2. **It survives on-premises deployment.** A self-hosted install can
   ship fingerprints even when it will never ship summaries, so the
   loop keeps running for exactly the customers the hosted model would
   otherwise lose.

### What the corpus produces

Ranked by frequency across installations, weighted by how many call
sites each fingerprint blocks, the corpus is a pack backlog written by
the field rather than by intuition. The strategy review already flagged
that recognizer and discovery fixes should be ordered by what
production code shows rather than by what seems likely. This is the
mechanism for that.

It also feeds the pack authoring tooling already on the backlog. A
fingerprint plus two or three anonymized shape instances is close to
sufficient input for drafting a pack pattern, by a person or a model.
The bottleneck named there was clear specification of the pattern
vocabulary; a fingerprint is an instance of that vocabulary by
construction, since it is expressed in the vocabulary's own terms.

And it makes the moat measurable. Ship a pack version, watch the
unrecognized count for that fingerprint fall in the next extraction
across the installed base. Recognition rate per language, per
framework, per organization is a number that goes up, which is a
different kind of claim from "we have more integrations."

### Who owns which half

Packs stay open. The corpus and the ranking are product.

This is the defensible line, and it has a useful property: because the
packs are open, a customer who hits an unrecognized pattern can write
the pack themselves and contribute it, which is the behavior that
sustains adoption. What they cannot reproduce is knowing which
patterns matter most across everyone, which is the thing that decides
where the next ten packs go.

A team can copy every pack in the repository. They cannot copy the
ranked list of what is still missing.

### Consequences for what gets built

- The extraction funnel is on the critical path twice, once as a
  usability fix and once as the sensor the loop runs on. Build it so
  the report is structured data with a rendering on top, not a printed
  string.
- Fingerprinting should be designed alongside the funnel rather than
  retrofitted. The funnel already has to describe why a stage produced
  nothing; a fingerprint is that description with identifiers stripped.
- Emission is opt-in and inspectable. A user should be able to run the
  command that prints exactly what would be sent, in full, and that
  output should be short enough to read.
- The gate ships before the graph. Fingerprints flow from the gate as
  readily as from the graph, so the loop does not have to wait for the
  larger product.
