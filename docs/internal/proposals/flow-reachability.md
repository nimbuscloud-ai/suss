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
reachability is a walk over them. Nothing about ALB, ECS, or Lambda
appears in the walk. That is the requirement the fixture encodes:
each pattern shape forwards to both target kinds, so a resolver
keyed on anything but the declared wiring picks the wrong backend
for two of its four rules.

The work splits into two layers, and saying so plainly is the first
design decision. The datalog engine holds tuples of strings and
numbers and joins them by equality; it has no function-valued terms
and no aggregation, so a fact cannot carry a matcher and a rule
cannot pick a minimum. Matching and priority selection therefore
happen in TypeScript before evaluation, the same division
`singleRoutedSubjectOf` already uses to settle which subject feeds a
queue: TypeScript decides the contested hops, the engine walks the
settled ones. The recursive part stays a rule because that is what
the engine is for; the protocol-specific part stays in dispatched
TypeScript because that is what the registry pattern is for.

## The facts

**Routing edges** come from the manifest reader. Each says one
resource forwards traffic to another, with the match that gates it
recorded as data (pattern strings, condition fields, priority), not
as behavior:

    routesTo(router, target, matchId)   a listener rule: its
                                        conditions and priority live
                                        on the match record
    answers(router, matchId, response)  a non-forward action: the
                                        fixture's fixed-response 404
                                        default, so an unmatched
                                        path lands somewhere stated
    fronts(target, resource)            what backs a target group

`fronts` terminates on a resource, not necessarily a deployable
unit. The walk decides unit-ness by whether a code scope fact exists
for the resource, which keeps the vocabulary open to the hop shapes
the fixture does not have: a CloudFront behavior fronting an ALB is
`fronts(distribution, alb)` and the walk keeps going; an API
Gateway method that already resolved its integration one-hop skips
edge vocabulary entirely and contributes a serving claim directly,
which the aws-apigateway reader in fact already computes. Before
slice 1 locks the names, the vocabulary gets checked against those
two shapes on paper, since the edge kinds are the contract the
Terraform reader inherits per manifests-as-facts.

An ALB rule's conditions are typed fields (path-pattern,
host-header, method, headers, query, source ip), ANDed across
fields, ORed within one. The match record carries all of them; v0
matching implements path-pattern and host-header and records the
rest as unevaluated, surfaced in the rendering rather than silently
treated as admitting.

**Serving claims** come from summaries suss already extracts: a rest
provider whose code scope sits inside a unit claims
`serves(unit, method, path)`.

This is where the fixture exposes a prerequisite. An Express route
declared on a mounted router extracts today without its mount
prefix: the fixture's own `/_health` route summarizes as `/_health`,
not `/api/orders/_health`, so the exact-match hop the fixture staged
(`OrdersHealthRule`) cannot resolve until mount-prefix composition
lands. The hono pack documents the same gap for `app.route`. Closing
it is slice 2 and blocks the walk; pretending flows work while
serving claims carry wrong paths would produce confident wrong
answers, the one failure mode this tool must never have.

**Calling claims** are the client side: a consumer summary claims
`calls(unit, method, url)`.

## The walk

For a queried method and URL, a TypeScript pass dispatches each
edge's match record to its owner's matcher (the ALB glob language
and the Express path language disagree in corners, so each protocol
matches its own), selects the winning edge per router by its
declared ordering (lowest priority first for ALB), and asserts
ground `admits(edge)` facts. The recursive rule then walks only
settled edges:

    reaches(entry, resource) when an admitted edge chain connects
                             them, ending at a resource with a code
                             scope or at an answers() action

No negation, no aggregation, no matcher calls inside the engine, so
the rule stays inside what the engine's resume machinery supports
today; walkers-and-rules records what negation costs and this
design does not spend it.

## What a user sees

The demo is the fixture's question answered at the terminal, as an
inspect view rather than a fifth CLI surface. The README commits to
four surfaces over one artifact set, and a flow is a reading of
facts plus summaries, which is inspect's job:

    suss inspect --flow "GET https://shop.example.com/api/orders/123"

    client src/client/fetchOrder.ts
      -> ShopHttpsListener rule OrdersListenerRule  /api/orders/*
      -> OrdersTargetGroup -> OrdersService (ecs-task orders-app)
      -> app.all /api/orders/* -> getOrder  (src/orders-app/...)

Every hop names its evidence. A hop nothing declared shows as a
symbolic ref with what is known, following the unnamed-boundaries
rule that absence is a recorded state. A path no rule admits lands
on the listener's `answers()` action and renders that. If flows
outgrow inspect, promoting the view to its own verb is a deliberate
README change, not a side effect here.

## Slices

1. **Edges from the CFN reader.** Listeners, rules with full
   condition records, default actions, target groups, the ECS
   flattening (service to task definition to container code scope,
   a multi-hop join the reader settles, not the walk), Lambda
   targets. Tests against the fixture; the pinned absence test
   flips. The vocabulary review against the API Gateway and
   CloudFront shapes happens here, before the names harden.
2. **Mount-prefix composition.** Express `app.use(prefix, router)`
   and hono `app.route` compose the prefix into the summarized
   path. Independently valuable (route summaries stop
   under-describing paths) and a prerequisite for serving claims
   the walk can trust.
3. **The match pass and the rule.** The TypeScript admits pass with
   per-protocol matchers behind a dispatch table, then `reaches`
   over settled edges plus serving claims. The fixture's four rules
   exercise both target kinds and both pattern shapes.
4. **The surface.** `suss inspect --flow`, rendering the chain with
   evidence, symbolic refs, and unevaluated condition fields shown
   as such.
5. **The second manifest language.** Terraform emits the same edges
   per manifests-as-facts. Nothing in slices 1 to 4 may depend on
   CFN spellings.

## Out of this proposal

DynamoDB (#143) came along for the ride in an earlier draft and
does not fit in a paragraph. The registry makes a new variant's
schema cheap, but storage pairs through a dedicated checker pass,
so a `storage-document` variant is priced by that pass, not by the
module; and stream consumers arriving as message-bus while writes
are storage effects leaves the two halves of one boundary with no
join. That deserves its own design pass, and #143 tracks it.

## Risks

- **Fact vocabulary lock-in.** The edge kinds are the contract the
  Terraform reader inherits, so slice 1's review treats naming and
  match-record shape as the decision that lasts, with the API
  Gateway and CloudFront shapes as the test cases.
- **The admits pass growing a shared pattern language.** ALB and
  Express globbing disagree in the corners (ALB `*` crosses `/`,
  Express semantics changed across majors), so matchers stay
  per-protocol behind the dispatch table; a shared language would
  be quietly wrong in exactly the way this tool exists to catch.
- **Scope creep toward middleware semantics.** The fixture's
  dispatch middleware resolves by reading the sub-path in code. The
  walk ends at the wildcard route's handler, and the flow renders
  the handler's own transitions rather than pretending the router
  goes deeper.
