# @suss/datalog

A small semi-naïve Datalog evaluator with stratified negation. This is
the rules engine behind suss's derived program facts.

## Why suss carries a Datalog engine

Extraction keeps meeting problems that are naturally *fixpoints*: which
functions are reachable from an entry point, what a bare `throw err`
re-throw can actually raise (the union of what everything in the `try`
block throws, transitively), how a wrapper-of-a-wrapper resolves to its
underlying route. Expressed as rules over base facts, each analysis is
a few auditable lines:

```ts
import { Database, evaluate, lit, rule, variable as v } from "@suss/datalog";

const db = new Database();
db.add("entry", ["main"]);
db.add("calls", ["main", "helper"]);
db.add("calls", ["helper", "util"]);

evaluate(db, [
  rule("reachable", [v("f")], [lit("entry", v("f"))]),
  rule(
    "reachable",
    [v("g")],
    [lit("reachable", v("f")), lit("calls", v("f"), v("g"))],
  ),
]);

db.facts("reachable"); // [["main"], ["helper"], ["util"]]
```

Termination and soundness are the engine's job, proven once. Negation
(`notLit`) is *stratified*: a rule set with a negation cycle is a hard
error at evaluation time, the property that makes rules safe to audit
independently of any engine.

Because rules are plain data (no DSL strings, no embedded code), the
same rule set can later run on a faster external engine, and (the
longer game) analyses written against fact shapes (`calls`, `throws`,
`handles`, …) are language-independent: a second language adapter only
has to emit the same facts.

## Design constraints

1. **Pure TypeScript, zero dependencies.** The npm-shipped CLI cannot
   require a native binary.
2. **Rules are data.** `Rule` / `Literal` / `Term` objects, built with
   `rule` / `lit` / `notLit` / `variable` / `constant`.
3. **Sound negation only.** Stratification is checked; negated literals
   must ground all variables from earlier positive literals.

## What it does to stay quick

Semi-naïve iteration keeps per-round work proportional to newly derived
facts rather than to everything known.

Joins narrow before they scan. Once a literal has any term fixed, either
written as a constant or bound by an earlier literal, the join looks the
value up in a per-column index instead of walking the relation. A column
gets indexed the first time something asks for it and stays current
after that, so a relation nobody joins on that way carries no index.

`evaluate` picks up where it left off. Call it again with the same rules
after adding facts and it seeds from the facts you added rather than
starting the fixpoint over. Callers that interleave "add some facts, ask
a question" get this without doing anything. Negation turns it off:
adding a fact can make a negated literal stop matching, which retracts a
conclusion, and a delta pass only ever adds. Positive rules are monotone,
so everything derived before still holds.

Extraction-scale fact sets are thousands of tuples. If that changes, the
rule data model is the stable seam and this evaluator is the replaceable
part.
