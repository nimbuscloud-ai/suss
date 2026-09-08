# @suss/datalog

Part of [suss](https://github.com/nimbuscloud-ai/suss), which reads both sides of every call in a repository and says where the two disagree.

A small semi-naïve Datalog evaluator with stratified negation. This is
the rules engine behind suss's derived program facts.

## Why suss ships a Datalog engine

Extraction keeps running into problems that are naturally *fixpoints*:
which functions are reachable from an entry point, what a bare `throw
err` re-throw can actually raise (the union of everything the `try`
block throws, transitively), how a wrapper of a wrapper resolves to its
underlying route. Write each of those as rules over base facts and it
comes to a few lines you can check by reading them:

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

Termination and soundness are the engine's job, and we prove them once.
Negation (`notLit`) is *stratified*: a rule set with a negation cycle is
a hard error at evaluation time, and that is what lets you check a rule
on its own without thinking about the engine.

Because rules are plain data, with no DSL strings and no embedded code,
the same rule set can later run on a faster external engine. Over the
longer term, an analysis written against a set of facts (`calls`,
`throws`, `handles`, and so on) does not depend on the language: a
second language adapter only has to emit the same facts.

## More

- [How the engine evaluates](./DESIGN.md)
- [Documentation](https://nimbuscloud-ai.github.io/suss/)
- [Source and issues](https://github.com/nimbuscloud-ai/suss)

![coverage](../../.github/badges/coverage-datalog.svg)

Apache 2.0. See [LICENSE](../../LICENSE).
