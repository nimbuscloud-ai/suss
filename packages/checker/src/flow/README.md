# flow/

This module answers "who serves this request" by walking the routing edges
that manifest readers emit: a listener rule forwards to a target group, the
target group fronts a resource, a load balancer that something fronts passes
the request on to its own listeners, and the walk ends at a resource with a
code scope or at a declared response.

## The split

The datalog engine joins tuples by equality. It cannot run a matcher or pick
a winner, so the contested part is settled in TypeScript first. Each router's
match records go to the selector for their own condition language, through a
table keyed by the `matchLanguage` the reader stamped, and the selection comes
out as ground `admits` / `mayAdmit` facts. The recursive part stays a rule set
(`FLOW_RULES`), a fixpoint over a finite set of nodes, which is why a cycle of
edges terminates instead of looping forever.

Nothing here interprets a condition, a priority, or a resource kind. The ALB
glob rules and the lowest-priority-first ordering live with the CloudFormation
reader that owns that vocabulary. Route matching for a serving claim lives
with its protocol's semantics module, and the walk asks for it through
`servesRequest`. A router whose language has no selector in the table
abstains: its matches stay possible, never admitted and never refused.

## Certainty

There are two relations, and neither one guesses. `reaches` walks edges whose
match took the request outright. `mayReach` also walks edges whose match could
take it once something undeclared is decided at runtime: a condition field
nobody evaluated, a priority tie, a match language nobody can evaluate.
Everything `reaches` derives, `mayReach` derives too, so "possible but not
certain" is a set difference, and a condition nobody evaluated can never turn
into reachable-no.

## Identity

Every node the walk joins on is keyed by (document scope, name). A logical id
is unique inside one document and nowhere else, so two unrelated stacks that
both declare an `HttpListener` are two nodes, and neither one can stand in for
the other. The scope is the root document label read off each summary's own
provenance (`rootDocumentLabel` in `@suss/behavioral-ir`), so every document
in one nested-stack tree shares one scope and the joins inside that tree still
work, including the listeners of a balancer that something fronts.

The summaries themselves keep the bare names their documents wrote, and
nothing changes about the identity rules on the pairing side: a `fronts`
edge's resource still matches a unit's stack-path-qualified `instanceName`,
and a message-bus channel still keeps the name the code uses, whichever
document declared the queue. Only the walk's keying is scoped. When a query
uses an entry name that two documents both declare, the walk refuses it until
the caller passes the document scope, because merging the two would answer one
stack's question with another stack's rules. A manifest reader labels each
document by where it lives in its repository, so the `template.yaml` files of
two services are two labels and two scopes. What is left open is names that
cross documents on purpose, like channels.

## Key files

- `routingFacts.ts` turns the routing metadata namespace into joinable
  tuples, groups each router's match records for its selector, and places
  serving claims into units via `scope/`.
- `reachability.ts` contains `FLOW_RULES` and `analyzeFlow`, the entry point
  for one request. Results come back as data, and `suss inspect --flow` in
  the CLI is what renders them at the terminal.
- `flowChains.ts` reconstructs the route behind a result: the hops a request
  took and the match record responsible for each one, so a person can be told
  which rule sent them where. It only steps into nodes the fixpoint already
  put in reach, so the chains and the reachable sets cannot disagree. When a
  rule took the request and pointed at a target that nothing resolved, its
  chain ends as `unfollowed`, with the reference and the reader's reason
  attached, because "the request goes here and suss cannot say what happens
  next" and "nothing is declared here" are different answers. It keeps a
  bounded number of chains and reports how many more it found, so a broad
  result is never quietly a partial one.
