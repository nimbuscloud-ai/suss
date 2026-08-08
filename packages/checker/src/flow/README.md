# flow/

Answers "who serves this request" by walking the routing edges manifest
readers emit: a listener rule forwards to a target group, the target group
fronts a resource, a fronted load balancer hands to its own listeners, and the
walk ends at a resource with a code scope or at a declared response.

## The split

The datalog engine joins tuples by equality; it cannot run a matcher or pick
a winner. So the contested part is settled in TypeScript first: each router's
match records go to the selector for their own condition language, through a
table keyed by the `matchLanguage` the reader stamped, and the selection lands
as ground `admits` / `mayAdmit` facts. The recursive part stays a rule set
(`FLOW_RULES`), a fixpoint over a finite node set, which is why a cycle of
edges terminates instead of looping.

Nothing here interprets a condition, a priority, or a resource kind. The ALB
glob rules and the lowest-priority-first ordering live with the CloudFormation
reader that owns that vocabulary; a serving claim's route matching lives with
its protocol's semantics module and is asked through `servesRequest`. A router
whose language has no selector in the table abstains: its matches stay
possible, never admitted and never refused.

## Certainty

Two relations, never a guess. `reaches` walks edges whose match took the
request outright; `mayReach` also walks edges whose match could take it once
something undeclared is decided at runtime: an unevaluated condition field, a
priority tie, a match language nobody can evaluate. Everything `reaches`
derives, `mayReach` derives too, so "possible but not certain" is a set
difference and an unevaluated condition can never turn into reachable-no.

## Identity

Every node the walk joins on is keyed by (document scope, name). A logical id
is unique inside one document and nowhere else, so two unrelated stacks that
both declare an `HttpListener` are two nodes, and neither can answer for the
other. The scope is the root document label read off each summary's own
provenance (`rootDocumentLabel` in `@suss/behavioral-ir`), so every document
of one nested-stack tree shares one scope and joins within the tree still
hold, a fronted balancer's listeners included.

The summaries themselves keep the bare names their documents wrote, and the
pairing-side identity rules are untouched: a `fronts` edge's resource still
matches a unit's stack-path-qualified `instanceName`, and a message-bus
channel still keeps the name the code says, whichever document declared the
queue. Only the walk's keying is scoped. A query whose entry name two
documents both declare is refused until the caller passes the document scope,
because merging them would answer one stack's question from another stack's
rules. A manifest reader labels each document by where it sits in its
repository, so two services' `template.yaml` are two labels and two scopes.
The residual hole is names that cross documents by design, like channels.

## Key files

- `routingFacts.ts` reads the routing metadata namespace into joinable
  tuples, groups each router's match records for its selector, and places
  serving claims into units via `scope/`.
- `reachability.ts` holds `FLOW_RULES` and `analyzeFlow`, the per-request
  entry point. Results come back as data; rendering them at the terminal is
  `suss inspect --flow`, in the CLI.
- `flowChains.ts` reconstructs the route behind an answer: the hops a request
  took and the match record that carried each one, so a person can be told
  which rule sent them where. It only steps into nodes the fixpoint already
  put in reach, so the chains and the reachable sets cannot disagree. A rule
  that took the request and named a target nothing resolved ends its chain as
  `unfollowed`, carrying the reference and the reader's reason, because "the
  request goes here and suss cannot say what happens next" and "nothing is
  declared here" are different answers. It keeps a bounded number of chains
  and reports how many more it found, so a wide answer is never quietly a
  partial one.
