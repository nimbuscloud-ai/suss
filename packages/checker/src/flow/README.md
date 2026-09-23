# flow/

This module works out which unit serves a request. It walks the routing
edges that manifest readers emit. A listener rule forwards to a target
group, and the target group fronts a resource. A load balancer that
something fronts passes the request on to its own listeners. The walk
ends at a resource with a code scope or at a declared response.

## The split

The datalog engine joins tuples by equality. It cannot run a matcher or
pick a winner, so TypeScript settles the contested part first. Each
router's match records go to the selector for their condition language,
through a table keyed by the `matchLanguage` the reader stamped. The
selection comes out as ground `admits` / `mayAdmit` facts. The recursive
part stays a rule set (`FLOW_RULES`). It is a fixpoint over a finite set
of nodes, so a cycle of edges terminates instead of looping forever.

This module does not interpret conditions, priorities or resource kinds.
The ALB glob rules and the lowest-priority-first ordering live in the
CloudFormation reader, which defines that vocabulary. Route matching for
a serving claim lives in its protocol's semantics module, and the walk
calls it through `servesRequest`. When a router's language has no
selector in the table, the walk abstains: that router's matches stay
possible, and are neither admitted nor refused.

## Certainty

There are two relations, and neither one guesses. `reaches` walks edges
whose match took the request outright. `mayReach` also walks edges whose
match could take the request once something undeclared is decided at
runtime, such as a condition field nobody evaluated or a priority tie.
A match language nobody can evaluate counts the same way. Everything
`reaches` derives, `mayReach` derives too. "Possible but not certain" is
therefore a set difference, and a condition nobody evaluated never turns
into a claim that the request does not reach a node.

## Identity

Every node the walk joins on is keyed by (document scope, name). A
logical id is unique inside one document and nowhere else. Two unrelated
stacks that both declare an `HttpListener` are two nodes, and neither can
stand in for the other. The scope is the root document label read off
each summary's own provenance (`rootDocumentLabel` in
`@suss/behavioral-ir`). Every document in one nested-stack tree shares one
scope, so the joins inside that tree still work, including the listeners
of a balancer that something fronts.

The summaries themselves keep the bare names their documents wrote, and
the identity rules on the pairing side stay the same. A `fronts` edge's
resource still matches a unit's stack-path-qualified `instanceName`. A
message-bus channel still keeps the name the code uses, whichever
document declared the queue. Only the walk's keying is scoped. When a
query uses an entry name that two documents both declare, the walk
refuses it until the caller passes the document scope, because merging
the two would apply one stack's rules to another stack's request. A
manifest reader labels each document by its location in the repository,
so the `template.yaml` files of two services get two labels and two
scopes. Names that cross documents on purpose, such as channels, stay
unscoped.

## Key files

- `routingFacts.ts` turns the routing metadata namespace into joinable
  tuples, groups each router's match records for its selector, and places
  serving claims into units via `scope/`.
- `reachability.ts` contains `FLOW_RULES` and `analyzeFlow`, the entry
  point for one request. Results come back as data, and `suss inspect
  --flow` in the CLI renders them at the terminal.
- `flowChains.ts` reconstructs the route behind a result: the hops a
  request took and the match record responsible for each one. That lets
  suss tell a person which rule sent the request where. It only steps into
  nodes the fixpoint already put in reach, so the chains and the reachable
  sets cannot disagree. When a rule took the request and pointed at a
  target that nothing resolved, its chain ends as `unfollowed`, with the
  reference and the reader's reason attached. "The request goes here and
  suss cannot say what happens next" is a different result from "nothing
  is declared here". The module keeps a bounded number of chains and
  reports how many more it found, so a broad result is never silently a
  partial one.
