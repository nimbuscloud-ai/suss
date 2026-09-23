# Open source and product, revised

This covers where the line falls between what ships as open source and
what the company sells, what the July run against a production monorepo
changed about that, and what the resulting design has to account for.

## The split still holds

Primitives that work on a single repo at a single moment ship as open
source. Features that span repos, time or a whole organization are
product. Nothing in the recent work argues against that split.

**Open source.** Extraction produces behavioral summaries from a
codebase. Contract readers turn schemas and templates into the same
form. Checkers compare a pair at one moment: contract consistency,
GraphQL agreement, message-bus pairing, storage access, env-var config
and intent coverage. That is already a long way past printing findings
to stdout, so we should not position the product as the version that
works.

**Product.** Summaries from every service in an organization, kept as
one graph over time. The handler in service A changed its behavior in
Tuesday's deploy, and three consumers in B, C and D have not caught up.
The product adds history, correlation, alerting, workflow integration,
and the context layer that agents query.

## Four amendments

### Adoption works differently from Sentry

Sentry's SDK works because it instruments at runtime and works the same
everywhere. You import it and errors start arriving, whatever way your
team writes code.

suss produces its data by static analysis, and that analysis has to
recognize how a team writes its boundaries. The July run showed where
this breaks. One team wraps Apollo in a single local hook and calls that
hook everywhere. The Apollo pack looks for the library call itself, so
suss saw only the handful of call sites that still called Apollo
directly, and the team got almost nothing from it. Another team builds
its Lambda response envelope through a local helper, and suss got
whatever argument order the pack guessed. The pack guessed wrong, so
every status and body suss extracted came back swapped, at high
confidence. Neither pattern is unusual.

So getting started is not three lines and no configuration. It depends
on whether a pack recognizes the way your team writes code. That is the
biggest threat to the funnel argument, because the whole model depends
on the data being cheap to produce.

### The moat is the pack corpus

If recognizing production code is the hard part, then what we learn
about how codebases express boundaries is the asset that keeps growing
in value. It is also harder to copy than an ingestion pipeline.

That gives us a feedback loop Sentry does not have. Sentry's SDK does
not improve because Sentry's backend saw your errors. suss's extraction
would improve from what the product sees. The design for that loop is
below. Getting it right early matters more than getting the graph right
early.

### Self-hosting is a requirement

Sentry ingests runtime error events, and teams already accept sending
those off their machines. A behavioral summary is derived from source:
function names, file paths, response shapes, branch conditions. Sending
one is closer to sending a code index than to sending error events, and
enterprise buyers will treat it that way.

This does not break the model. It turns VPC and on-premises deployment
and summary redaction from later concerns into requirements. It also
argues against assuming the hosted version is the only one anyone
wants.

### The intent layer moved the center of gravity

The earlier plan was built around drift between services over time,
which needs a graph and history. The strategy review settled on a
different way in: checking generated code against intent, as a gate on
each change that runs in the pull request.

Both can be true. They are different products that need different
things built first, and the gate is much cheaper to ship than the
living graph. Build the gate first and let the graph grow out of it.

## Designing the recognition loop

The claim is that extraction gets better because the product saw what
extraction failed to recognize. That only works if three things are
true. Something has to capture the failure, the failure has to be
allowed to leave the customer's network, and it has to arrive somewhere
that turns it into a pack.

### What the signal is

The IR already records most of it, for other reasons:

- **Confidence levels.** A summary or transition that came back `low`
  marks a place where extraction looked for something and did not find
  it.
- **Gaps.** `detectGaps` runs in both directions. It records declared
  outcomes that are never produced and produced outcomes that are never
  declared.
- **Opaque predicates.** Every condition that could not be broken down
  keeps its source text and a reason.
- **Accounting units.** The Lambda pack emits `recognized-not-http`
  units, so a handler the template declares is never dropped without a
  record.
- **Unmatched buckets.** Pairing already separates providers with no
  counterpart from summaries with no binding at all.

The one missing piece is the extraction funnel. It would count the
files in the include set, the candidates that get past each pack's
import gate, the units discovered, and the units with no terminals.
That is the diagnostics work already queued. It captures extraction
that failed completely, where the signals above only capture partial
failure. So the sequencing changes. The diagnostics item fixes a
usability problem, and it is also the sensor the whole loop depends on.

### Report fingerprints instead of code

The report cannot include source code. An organization that will not
send out summaries will certainly not send out the code that failed to
parse, and that constraint is where the Sentry model would break.

So the unit of feedback is a structural fingerprint. It describes what
was not recognized, with every identifier, literal and path removed.
The response-helper case becomes something like

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

Neither one includes a function name, a file path, or a business term.
Two properties follow, and both matter more than privacy alone would
suggest:

1. **Fingerprints can be aggregated.** Fingerprints from different
   organizations collide when the underlying pattern is the same, and
   that turns a pile of individual failures into a ranked list.
2. **They work with on-premises deployment.** A self-hosted install can
   send fingerprints even when it will never send summaries. So the
   loop keeps running for exactly the customers the hosted model would
   otherwise lose.

### What the corpus produces

Rank the fingerprints by how often they show up across installations
and weight them by how many call sites each one blocks. The corpus then
becomes a pack backlog driven by what happens in the field, and nobody
has to guess. The strategy review already said recognizer and discovery
fixes should be ordered by what production code shows and not by what
seems likely. This gives us a way to do that.

It also feeds the pack authoring tools already on the backlog. A
fingerprint plus two or three anonymized examples is close to enough
input for a person or a model to draft a pack pattern. The backlog item
said the bottleneck was specifying the pattern vocabulary clearly. A
fingerprint is written in the terms of that vocabulary, so every
fingerprint is an example of it.

And it lets us measure the moat. Ship a pack version, then watch the
unrecognized count for that fingerprint fall in the next extraction
across the installed base. The recognition rate per language, per
framework and per organization is a number that goes up. That is a
different kind of claim from "we have more integrations."

### Who owns which half

Packs stay open source. The corpus and the ranking are product.

We can defend that line, and it has a useful property. The packs are
open, so a customer who hits an unrecognized pattern can write the pack
and contribute it, and that keeps adoption going. What they cannot
reproduce is knowing which patterns matter most across every customer,
and that knowledge decides where the next ten packs go.

A team can copy every pack in the repository. They cannot copy the
ranked list of what is still missing.

### Consequences for what gets built

- The extraction funnel is on the critical path twice: once as a
  usability fix, and once as the sensor the loop runs on. Build it so
  the report is structured data with a rendering on top, and not a
  printed string.
- Design fingerprinting together with the funnel, so it does not have
  to be added afterwards. The funnel already has to describe why a
  stage produced nothing, and a fingerprint is that description with
  the identifiers removed.
- Sending reports is opt-in, and a user can look at what goes out. A
  user should be able to run a command that prints exactly what would
  be sent, in full, and that output should be short enough to read.
- The gate ships before the graph. Fingerprints come from the gate as
  easily as from the graph, so the loop does not have to wait for the
  larger product.
