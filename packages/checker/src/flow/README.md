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

## Key files

- `routingFacts.ts` reads the routing metadata namespace into joinable
  tuples, groups each router's match records for its selector, and places
  serving claims into units via `scope/`.
- `reachability.ts` holds `FLOW_RULES` and `analyzeFlow`, the per-request
  entry point. Rendering a flow at the terminal is inspect's job and a later
  slice; here the results come back as data.
