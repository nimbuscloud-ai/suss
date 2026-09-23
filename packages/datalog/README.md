# @suss/datalog

Part of [suss](https://github.com/nimbuscloud-ai/suss), which reads both sides of every call in a repository and says where the two disagree.

A small semi-naïve Datalog evaluator with stratified negation. suss
derives its program facts with it.

## Why suss ships a Datalog engine

Extraction keeps running into problems that are *fixpoints*. One is
which functions are reachable from an entry point. Another is what a
bare `throw err` re-throw can raise, which is the union of everything
the `try` block throws, transitively. A third is how a wrapper of a
wrapper resolves to its underlying route. Written as rules over base facts,
each one comes to a few lines you can check by reading them:

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

The engine guarantees termination and soundness, and those are proved
once, for the engine. Negation (`notLit`) is *stratified*: a rule set
with a negation cycle is a hard error at evaluation time. Because of
that, you can check a rule on its own without thinking about the engine.

Rules are plain data, without DSL strings or embedded code, so the same
rule set can later run on a faster external engine. An analysis written
against a set of facts (`calls`, `throws`, `handles`, and so on) does
not depend on the language. A second language adapter only has to emit
the same facts.

## More

- [How the engine evaluates](./DESIGN.md)
- [Documentation](https://suss.sh/)
- [Source and issues](https://github.com/nimbuscloud-ai/suss)

![coverage](../../.github/badges/coverage-datalog.svg)

Apache 2.0. See [LICENSE](../../LICENSE).
