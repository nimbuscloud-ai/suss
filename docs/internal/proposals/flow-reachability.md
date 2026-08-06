# Flow reachability: who serves this URL

Issue #144. The fixture at `fixtures/aws-alb` asks the question this
proposal answers: a client calls
`GET https://shop.example.com/api/orders/123`, a listener rule
matches `/api/orders/*`, forwards to a target group fronting an ECS
service whose container runs an Express app, the app's wildcard route
hands the sub-path to a dispatch middleware, and `getOrder` answers.
Today suss sees the client call, the compute units, and the Express
routes, and none of the wiring between them. The pinned test in
`packages/contract/cloudformation/src/albFlow.test.ts` asserts
exactly that absence and is written to fail the day this ships.

## The shape of the answer

A flow is a chain of hops, each hop a fact somebody emitted, and
reachability is one rule walking them. Nothing about ALB, ECS, or
Lambda appears in the rule. That is the requirement the fixture
encodes: each pattern shape forwards to both target kinds, so a
resolver keyed on anything but the declared wiring picks the wrong
backend for two of its four rules.

The datalog engine already runs every fixpoint analysis in the tree,
and the walkers-and-rules and manifests-as-facts proposals already
committed us to "readers emit facts, rules derive answers." This
proposal is those two commitments meeting the north-star question.

## The facts

Three kinds, all emitted by things that already exist:

**Routing edges** come from the manifest reader. Each edge says one
resource forwards traffic to another, with the match that gates it:

    routesTo(listener, targetGroup, match)   an ALB listener rule:
                                             host, path pattern,
                                             priority
    fronts(targetGroup, unit)                what backs the group: the
                                             ECS service's container,
                                             or the Lambda function

The ECS chain (rule to group to service to task definition to
container code scope) and the Lambda chain (rule to group to
function code scope) both flatten into the same two edge kinds. The
CFN reader resolves the intermediate hops the way it already
resolves queue and topic refs; the reachability rule never learns
they existed.

**Serving claims** come from summaries suss already extracts. A rest
provider summary with its code scope inside a unit's scope claims
`serves(unit, method, path)`. The Express mount prefix and the
wildcard route are already in the summary after #140; the mount gap
(a route declared on a sub-app reported without its prefix) is a
named limitation in the hono pack today and becomes a visible hole
in flows, which is the right pressure.

**Calling claims** are the client side: a consumer summary claims
`calls(unit, method, url)`.

## The rule

One recursive rule composes edges from an entry point to a serving
claim, threading the request's method and path through each hop's
match:

    reaches(entry, unit) when routesTo/fronts edges connect them
                         and every match on the way admits the path

Per-hop match semantics stay with the hop's emitter, the same
inversion the semantics registry uses. An ALB path pattern (`*` and
`?` globs, first match by priority) and an Express pattern
(`:params`, mount prefixes) are different languages; each fact
carries its own matcher, exposed to the rule as a predicate, so the
rule composes matchers without knowing either language. This is the
boundary-semantics move applied to routing: the protocol owns its
matching, the generic layer owns the walk.

Priority is data on the edge. First-match-wins is a property of the
listener, so the rule prefers the lowest priority edge whose match
admits the path, which is a plain aggregation the engine already
supports.

## What a user sees

The demo is the fixture's question answered at the terminal:

    suss flow GET https://shop.example.com/api/orders/123

    client src/client/fetchOrder.ts
      -> ShopHttpsListener rule OrdersListenerRule  /api/orders/*
      -> OrdersTargetGroup -> OrdersService (ecs-task orders-app)
      -> app.all /api/orders/* -> getOrder  (src/orders-app/...)

Every hop names its evidence. A hop nothing declared shows as a
symbolic ref with what is known (`-> ? (target group names its
service at runtime)`), following the unnamed-boundaries rule that
absence is a recorded state, never a guess. The same walk with no
URL argument lists every entry point and where each lands, which is
the beginning of the intent-facing story: a PRD names a URL, and the
checker can now say which code answers it.

## Slices

1. **Edges from the CFN reader.** ALB listeners, rules, target
   groups, ECS service and task definition flattening, Lambda
   targets. Tests against the fixture; the pinned absence test flips
   to assert the paths. No rule work yet; the facts are inspectable
   on their own.
2. **The rule and the walk.** `reaches` over the edges plus serving
   claims derived from existing summaries, with the per-hop matcher
   seam. The fixture's four rules exercise both target kinds and
   both pattern shapes through the one rule.
3. **The surface.** `suss flow`, rendering the chain with evidence
   and symbolic refs. Inspect's boundary view links into it rather
   than growing its own walker.
4. **The second manifest language.** Terraform emits the same edges
   per manifests-as-facts: HCL read from the repo, refs recorded
   symbolically, plan JSON as an optional binding provider. Nothing
   in slices 1 to 3 may depend on CFN spellings; the edge vocabulary
   is the contract.

## A decision to make alongside: DynamoDB (#143)

The table resource needs a boundary identity before flows can end at
storage. Two options:

- **A storage variant of its own** (`storage-document` beside
  `storage-relational`): the schema matches the data model instead
  of stretching relational vocabulary, one more module in the
  registry, pairing by table identity the way relational pairs
  today. Streams stay message-bus: a stream-fed
  consumer arrives through the event source mapping the reader
  already understands, channelled on the table.
- **Widen storage-relational** into one storage variant with a
  system discriminator: fewer modules, but the schema starts
  carrying fields half its members cannot have, which is the shape
  the typed-claims work spent this week removing.

Recommendation: the variant of its own. The registry exists so
variants are cheap, and the fixture for it is the degree of coverage
the CFN bar needs before the Python corpus becomes a meaningful
test.

## Risks

- **Fact vocabulary lock-in.** The edge kinds are the contract the
  Terraform reader inherits, so slice 1's review should treat
  `routesTo`/`fronts` naming and match-payload shape as the decision
  that lasts, not the CFN parsing.
- **Matcher seams becoming matchers.** The temptation in slice 2 is
  one shared pattern language. ALB and Express globbing disagree in
  the corners (ALB `*` crosses `/`, Express `*` semantics changed
  across majors), so the seam stays per-hop; a shared language would
  be quietly wrong in exactly the way this tool exists to catch.
- **Scope creep toward middleware semantics.** The dispatch
  middleware in the fixture resolves by reading the sub-path in
  code. Slice 2 ends at the wildcard route's handler; saying which
  branch of the dispatch map answers is condition-level work the
  summaries already carry, and the flow renders it as the handler's
  own transitions rather than pretending the router goes deeper.
