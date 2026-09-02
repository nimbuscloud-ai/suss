# @suss/datalog

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

## Design constraints

1. **Pure TypeScript, zero dependencies.** The npm-shipped CLI cannot
   require a native binary.
2. **Rules are data.** `Rule` / `Literal` / `Term` objects, built with
   `rule` / `lit` / `notLit` / `variable` / `constant`.
3. **Sound negation only.** Stratification is checked; negated literals
   must ground all variables from earlier positive literals.

## What it does to stay quick

Semi-naïve iteration keeps the work in each round proportional to the
facts newly derived rather than to everything already known.

Joins narrow before they scan. Once a literal has any term fixed, either
written as a constant or bound by an earlier literal, the join looks the
value up in a per-column index instead of walking the whole relation. A
column gets indexed the first time something asks for it and stays up to
date after that, so a relation nobody joins on that way never gets an
index at all.

The body is not always walked in the order it was written. A round draws
one literal from the facts that arrived last round, and that list is
usually short, so it goes first and everything after it starts with some
variables already bound. Take `chain(x, z) :- chain(x, y), binds(y, z)`
in the round where new `binds` facts arrive. Written order asks for
`chain(x, y)` with nothing bound, which scans every chain fact and tries
each one against every new binding. Leading with the new bindings binds
`y`, and `chain` then comes off its index on that column. On suss's own
sources that one reordering took the rule from 2.4 seconds to 55
milliseconds.

Once the delta leads, the rest of the body follows greedily: the next
literal is one sharing a variable that is already bound, so it too comes
off an index rather than scanning. A negated literal is a filter, so it
is placed as soon as its variables are bound. A join produces the same
rows whatever order it walks in, so this changes what a round costs and
not what it derives.

`evaluate` picks up where it left off. Call it again with the same rules
after adding facts and it starts from the facts you added rather than
redoing the whole fixpoint. Callers that go back and forth between
adding facts and asking questions get this for free. Positive rules are
monotone, so everything derived earlier still holds.

Negated rules work differently. A new fact can make a negated literal
stop matching, and the conclusion that rested on it has to go. So when
you re-run with negated rules, the engine throws away what the previous
pass derived and works the answer out again from the base facts. Either
way, the database ends up with the answer for the facts it has now.

## Tagging derivations

A fact is normally there or not there. Pass `evaluate` a `TagAlgebra`
and every derived fact also gets a tag: `combine` turns the body's
tags into the head's, and `merge` decides what to keep when the same
fact is derived a second time. This is a provenance semiring in the
sense of Green, Karvounarakis, and Tannen (2007); Soufflé's provenance
mode stores a minimal proof height with the same two operations. Rules
never mention tags, and a call without an algebra runs as before.

```ts
const cost: TagAlgebra<number> = {
  asserted: 0, // what an untagged fact contributes
  absent: 0, // what a matched negated literal contributes
  combine: (tags) => tags.reduce((sum, tag) => sum + tag, 1),
  merge: (stored, incoming) => (incoming < stored ? incoming : stored),
};

evaluate(db, rules, cost);
db.tagOf("reaches", ["a", "c"]); // the cheapest derivation's cost
```

`combine` is also handed the derivation itself: the `Rule` that fired,
and one entry per body literal saying which fact it matched, or which
grounded tuple a negated literal checked and did not find. An algebra
that only folds tags, like the cost above, ignores it; the witness
algebra below is built out of it.

Tags are stored beside the relation, keyed the same way as the facts,
never in the tuple. A tuple is its own identity: were the tag part of it, an
improved tag would read as a new fact and the fixpoint would never
close. `Database.add` reports "added", "improved", or "unchanged", and
an improved fact re-enters the delta so conclusions built on it
recompute with the better tag.

The contract on `merge`:

- Return the stored tag itself, the same value by `===`, when the new
  derivation does not improve on it. Anything else is stored and
  re-derives downstream.
- For recursive rule sets, merge must be a bounded meet: repeated
  merges must stop improving after finitely many steps, the way `min`
  over numbers does. The engine does not check this; an algebra that
  keeps improving keeps evaluating.
- `undefined` is not a valid tag. The store uses it to mean "no tag",
  and `tagOf` returns it for untagged facts.

Two caveats. Supply the same algebra on every evaluation of a rule set
over a database: a resumed run derives only from facts added since, so
it tags only what those reach. And rules rewritten by `deriveOnDemand`
refuse an algebra: tags would follow the demand-transformed rules
rather than the ones you wrote, so `evaluate` throws instead.

## Witnesses, and proofs on demand

The `witnesses` algebra keeps one derivation per derived fact: the rule
that fired and one entry per body literal. Its merge keeps whatever is
already stored, so no fact ever re-enters the delta, the fixpoint
behaves exactly as it does untagged, and the tag stays one small object
per fact. `proofOf` then rebuilds the tree for one fact by walking
those witnesses backward, without re-running any rule:

```ts
import { evaluate, proofOf, ruleLabel, witnesses } from "@suss/datalog";

evaluate(db, rules, witnesses);
const proof = proofOf(db, "reachable", ["util"]);
// {
//   kind: "derived",
//   rule: <the Rule that fired>,
//   premises: [
//     { kind: "derived", ... },              // walked further down
//     { kind: "fact", relation: "calls", tuple: ["helper", "util"] },
//   ],
// }
```

A proof node is one of four kinds. `derived` has the rule and one
premise per body literal, in rule-body order. `fact` is a leaf with no
witness: the caller asserted it, or it was derived without the
algebra. `absence` is a leaf for a tuple missing from the database, at
the root when you ask about a fact that was never derived, and under a
derivation where a negated literal relied on the tuple being missing;
that absence is recorded at derivation time, so a proof can say "and no
handles(x) existed" without checking anything again. `truncated` is
where the walk stopped, at the depth cap (`maxDepth`, 128 unless you
say otherwise) or at a cycle.

First-wins gives you *a* proof, not the shortest one. When nine
derivations reach the same fact, the one stored is the one evaluation
found first. A different merge, say keeping the witness with the
smaller proof height, fits the same algebra interface without touching
the walk.

A proof shows each rule as `ruleLabel` renders it: the `name` you
passed as `rule`'s fourth argument, or the head and body relations, as
in `path :- path, !blocked`. The witness keeps the `Rule` object
itself, so two rules that render alike stay distinct.

## Confidence levels

The `confidence` algebra propagates how sure the run is of each fact,
as one of `"high"`, `"medium"`, or `"low"`. A rule firing takes the
minimum level across its body, so a conclusion is only as sure as its
weakest premise, and a fact derived twice keeps the better level. An
asserted fact without a tag counts as high; to say less, assert it
with a level:

```ts
import { confidence, evaluate } from "@suss/datalog";

db.add("edge", ["a", "b"]);            // high: read from source
db.add("edge", ["b", "c"], "medium");  // a guess somebody should check
evaluate(db, rules, confidence);
db.tagOf("path", ["a", "c"]); // "medium"
```

A rule can be a heuristic itself, and then its conclusions should not
outrank it. `confidenceWith` takes a level per rule and folds it into
the minimum; rules the callback returns `undefined` for count as
exact. Both operations are idempotent, so ten medium steps come out
medium, and a matched negation counts as high, because negation here
is exact over the database as computed.

## Deriving only what somebody asked for

A rule set written for a whole program derives every conclusion its
facts support, and a caller who asks about one value reads only a
handful of them. `deriveOnDemand` rewrites the rules so that conclusions
nobody is waiting on never get derived.

List the relations that have to come out whole, and give each of them a
rule that starts at a base relation you assert:

```ts
const rules = [
  rule("reaches", [v("x"), v("y")], [lit("edge", v("x"), v("y"))]),
  rule(
    "reaches",
    [v("x"), v("z")],
    [lit("edge", v("x"), v("y")), lit("reaches", v("y"), v("z"))],
  ),
  rule(
    "answer",
    [v("x"), v("y")],
    [lit("asked", v("x")), lit("reaches", v("x"), v("y"))],
  ),
];

const db = new Database();
db.add("edge", ["a", "b"]);
db.add("edge", ["b", "c"]);
db.add("edge", ["m", "n"]);
db.add("asked", ["a"]);

const program = deriveOnDemand(rules, ["answer"]);
evaluate(db, program.rules);
db.facts("answer"); // [["a", "b"], ["a", "c"]]
db.facts("reaches"); // the chain from a, and nothing from m
```

The rewrite is magic sets. Each derived relation gets a companion
relation that records which of its rows something is waiting on, that
companion becomes a literal in the rule body, and demand travels down
each body the same way the join binds variables. A relation nothing asks
for is not derived at all, so only read back the relations you listed.

The rewrite puts each body in the order demand should travel, which is
not always written order. At each position it takes the literal with the
most columns already fixed, by a constant or by a variable the head or
an earlier literal bound, and keeps written order between equals. Take
`moduleExport(m, n, v) <- reExports(m, n, m2, n2), moduleExport(m2, n2,
v)` asked with `v` bound. In written order the re-export comes first and
binds `m2` and `n2` off every re-export in the program, so the recursive
call wants `moduleExport` with all three columns bound: one demand fact
per re-export per value asked about. With `moduleExport(m2, n2, v)`
first, the demand stays on `v` and the re-exports come off an index on
`m2`. A body the head binds nothing in starts with its written first
literal.

This costs you two things. The companion relations are stored like any
other, at a few tuples per value asked about, so a caller who asks about
most of a program ends up deriving more rather than less. And the
rewrite refuses negation: a relation derived only where somebody asked
is smaller than the one a negated literal was written against, which
would make `not p(x)` match where it should not.

### Taking a question back

Demand is a fact, and a fact stays until somebody removes it. A caller
that asks a thousand questions of one database re-derives all thousand
every time new facts arrive, so the last question costs as much as a
thousand questions.

`program.demandDriven` lists the relations the rewrite restricts, and
`clearRelations` empties them once you have read an answer:

```ts
clearRelations(db, program.rules, [...program.demandDriven, "asked"]);

db.add("asked", ["m"]);
evaluate(db, program.rules);
db.facts("reaches"); // the chain from m, and nothing from a
db.facts("answer"); // a's answers, which nothing took away, plus m's
```

`retract` would send the next run back to the base facts, because a fact
leaving the database can take away a conclusion drawn anywhere.
`clearRelations` lets the next run resume instead, because a caller who
passes these relations is saying that nothing outside them was derived
from them. That is true for the relations `deriveOnDemand` restricts:
every one of them is derived under a demand fact, and only the relations
you listed as complete read from them. Those keep what they already
contain, which is the answers you have read.

Keep the facts you add and the facts the rules derive in separate
relations. Taking a conclusion back cannot tell one from the other, and
splitting them is how people normally write Datalog anyway.

### Reading what the rules are waiting on

Demand is also something a caller can read. `program.demands` lists
each demand relation with the relation it is for and which of that
relation's columns a demand row fixes, in column order:

```ts
program.demands;
// [{ relation: "reaches", bound: [true, false], demand: "wanted:reaches" }]
db.facts("wanted:reaches"); // [["a"], ["b"], ["c"]]
```

A caller that loads its base facts lazily uses this to find out what to
load next. Evaluate, read the demand rows on the relation whose base
facts come from somewhere else, fetch those, evaluate again, and stop
when no demand row is new. The rules then decide what gets loaded, and
the caller never has to guess how far a chain runs.

Extraction-scale fact sets run to thousands of tuples. If that changes,
the rule data model is the part that stays and this evaluator is the
part you replace.
