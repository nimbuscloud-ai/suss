# How the Datalog engine evaluates

The [README](./README.md) says what `@suss/datalog` is for.

## Design constraints

1. **Pure TypeScript with no dependencies.** The CLI ships on npm, so
   it cannot require a native binary.
2. **Rules are data.** A rule is made of `Rule` / `Literal` / `Term`
   objects, built with `rule` / `lit` / `notLit` / `variable` /
   `constant`.
3. **Negation must be sound.** The engine checks that the rules
   stratify. Every variable in a negated literal must be bound by an
   earlier positive literal.

## What it does to stay quick

The engine uses semi-naïve iteration. Each round costs in proportion to
the facts derived in the round before it, and the engine does not go
back over everything it already knows.

A round also runs only the rules that can use those facts. Each
stratum lists, per relation, the rules that read it in a positive
literal. A round runs the rules listed under the relations that gained
facts, in the order they were written, and skips the rest. A rule
with nothing new under any of its positive literals would not read a
row or derive anything. suss's resolution rules number in the hundreds,
and most rounds add facts to a few relations, so looking the rules up
costs less than checking each one. The join order and the rules that
fire are the ones a round over every rule gives, so the rows read and
the facts derived stay the same.

A join uses an index whenever it can. Once a literal has any term fixed,
either written as a constant or bound by an earlier literal, the join
looks the value up in a per-column index instead of walking the whole
relation. The engine builds a column's index the first time a join asks
for it and keeps it up to date after that. A relation that no join
reads by that column never gets an index.

Each relation stores its facts in a trie keyed on the tuple's atoms: a
tree of maps with one level per column. The node at the end of a walk
is the fact. If the node exists, the fact is known, and the node stores
the fact's tag. Checking whether a tuple is already known costs one map
lookup per column, stops at the first column that misses, and builds
nothing along the way.

The join makes that check constantly. Every candidate a rule derives
goes to `add`, and on a large project almost all of them are facts the
database already has. The engine used to identify a tuple by joining
its atoms into a string. For the node ids suss uses, that string ran to
60 or 200 characters. Building and hashing it took 41.6 seconds of a 71
second run over a 719-file Python project, more than half the whole
run.

The trie is keyed on the atoms themselves. Interning each atom to an
integer would cost two map lookups per column, one to get the integer
and one to follow it, where the atom needs one. The atoms a rule binds
are the same string objects the caller asserted, so V8 hashes each of
them once and keeps the hash, and the second lookup gains nothing.
Measured both ways, interning was slower.

The join does not always read a rule body in the order it was written.
In each round, one literal reads from the facts that arrived in the
previous round. That list is usually short and has no index, so the
join reads it first, once, and every literal after it starts with some
variables already bound. Take `chain(x, z) :- chain(x, y), binds(y, z)`
in the round where new `binds` facts arrive. Written order asks for
`chain(x, y)` with nothing bound, which scans every chain fact and tries
each one against every new binding. Reading the new `binds` facts first
binds `y`, and the join then reads `chain` through its index on that
column. On suss's own sources that one reordering took the rule from
2.4 seconds to 55 milliseconds.

After the first literal, the join picks the order again for each
binding. At every step it looks up how many rows each remaining literal
has under the variables bound so far, and reads the literal with the
fewest. If a literal has no rows under its bindings, the branch ends
there and no other literal is read. A rule like `out(x, y) :- asked(x),
wide(x, y), narrow(x, y)` reads one narrow row and then one wide row,
whichever way it was written. A fixed order that put `wide` second would
read every wide row for `x` and then reject all but one. A negated
literal only filters, so the join checks it as soon as its variables
are bound. A literal that shares no bound variable is scanned only when
nothing else is left. The join produces the same rows in any order, so
the ordering changes what a round costs and leaves what it derives
alone. An evaluation with a tag algebra joins in the same order, and a
witness still lists the body in the order the rule was written. When it
read bodies in written order instead, a witness pass over one Rails
project read 8.4 billion rows where the untagged pass read 3 million.

`evaluate` resumes from where it stopped. Call it again with the same
rules after adding facts, and it starts from the facts you added instead
of redoing the whole fixpoint. A caller that goes back and forth between
adding facts and asking questions gets this without doing anything.
Positive rules are monotone, so everything derived earlier still holds.

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
never mention tags. A call without an algebra runs the same as it did
before tags existed.

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
that only folds tags, like the cost above, ignores it. The witness
algebra below is built from it.

The relation stores tags beside its facts, keyed the same way, and
never puts a tag in the tuple. If the tag were part of the tuple, an
improved tag would look like a new fact and the fixpoint would never
close. `Database.add` returns "added", "improved", or "unchanged". An
improved fact goes back into the delta, so conclusions built on it are
recomputed with the better tag.

`merge` has to follow these rules:

- Return the stored tag itself, the same value by `===`, when the new
  derivation does not improve on it. Anything else is stored and
  re-derives downstream.
- For recursive rule sets, merge must be a bounded meet: repeated
  merges must stop improving after finitely many steps, the way `min`
  over numbers does. The engine does not check this; an algebra that
  keeps improving keeps evaluating.
- `undefined` is not a valid tag. The store uses it to mean "no tag",
  and `tagOf` returns it for untagged facts.

There are two caveats. Pass the same algebra on every evaluation of a
rule set over a database. A resumed run derives only from facts added
since the last one, so it tags only what those facts reach. Also,
`evaluate` throws if you pass an algebra with rules rewritten by
`deriveOnDemand`, because the tags would follow the demand-transformed
rules instead of the ones you wrote.

## Witnesses, and proofs on demand

The `witnesses` algebra keeps one derivation per derived fact: the rule
that fired and one entry per body literal. Its merge keeps whatever is
already stored. No fact re-enters the delta, so the fixpoint runs
exactly as it does untagged, and each fact's tag stays one small
object. `proofOf` then rebuilds the tree for one fact by walking those
witnesses backward, without re-running any rule:

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
algebra. `absence` is a leaf for a tuple missing from the database. It
appears at the root when you ask about a fact that was never derived,
and under a derivation where a negated literal relied on the tuple
being missing. The engine records the absence when it derives the fact,
so a proof can say "and no handles(x) existed" without checking
anything again. `truncated` marks where the walk stopped, at the depth
cap (`maxDepth`, 128 unless you say otherwise) or at a cycle.

Because the first witness stays, the proof you get is one valid proof
and may not be the shortest. When nine derivations reach the same fact,
the stored one is whichever evaluation found first. A different merge,
such as one that keeps the witness with the smaller proof height, would
fit the same algebra interface and leave the walk unchanged.

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

When a rule is itself a heuristic, its conclusions should be no surer
than the rule. `confidenceWith` takes a level per rule and folds it into
the minimum. A rule the callback returns `undefined` for counts as
exact. Both operations are idempotent, so ten medium steps come out
medium. A matched negation counts as high, because negation here is
exact over the database as computed.

## Deriving only what somebody asked for

A rule set written for a whole program derives every conclusion its
facts support. A caller who asks about one value reads only a handful
of them. `deriveOnDemand` rewrites the rules so that conclusions nobody
is waiting on never get derived. Profiles of suss's resolution rules
showed why this matters: one rule was attempted a hundred and fifty
times to produce fourteen tuples, and the tuples nobody read outnumbered
the ones somebody did by more than ten to one.

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

The rewrite is the magic sets transformation. Each derived relation
gets a companion relation that records which of its rows something is
waiting on. The companion becomes a literal in the rule body, and
demand travels down each body the same way the join binds variables. A
relation nothing asks for is not derived at all, so read back only the
relations you listed.

The rewrite orders each body for demand, and that order can differ from
the written one. At each position it takes the literal with the
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

A column that some rule writes a constant into does not count as fixed.
Such a column is a label, such as a kind or a mode, and has a handful
of values. A literal with only its labels bound matches nearly the
whole relation. Take
`reachesUnder(x, c, a, c3, kind) <- reachesUnder(x, c, p, c2, kind),
paramOf(f, i, p), entersUnder(r, f, c2, c3), callArg(r, i, a)` asked
with everything but `a` bound. Counting the contexts, `entersUnder` has
three columns fixed to `paramOf`'s one, and demand on it with `f` free
asks for every call made under that context, which is every call. With
the label columns left out, `paramOf` goes first, binds `f`, and the
demand on `entersUnder` is for one function.

The rewrite costs two things. The companion relations are stored like
any other, at a few tuples per value asked about, so a caller who asks
about most of a program ends up deriving more than it would without
the rewrite. The rewrite also rejects negation. A relation derived only
where somebody asked is smaller than the one a negated literal was
written against, so `not p(x)` would match where it should not.

### Taking a question back

Demand facts stay in the database until somebody removes them. A caller
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

With `retract`, the next run would start again from the base facts,
because a fact leaving the database can remove a conclusion drawn
anywhere. With `clearRelations` the next run resumes. By passing these
relations, the caller promises that nothing outside them was derived
from them. That is true of the relations `deriveOnDemand` restricts. Every one of them is derived under a demand fact, and only
the relations you listed as complete read from them. The complete
relations keep what they already contain, which is the answers you have
read.

Keep the facts you add and the facts the rules derive in separate
relations. When a conclusion is taken back, the engine cannot tell the
two apart. Most Datalog is written with them split anyway.

### Reading what the rules are waiting on

A caller can also read the demand. `program.demands` lists each demand
relation, the relation it serves, and which of that relation's columns
a demand row fixes, in column order:

```ts
program.demands;
// [{ relation: "reaches", bound: [true, false], demand: "wanted:reaches" }]
db.facts("wanted:reaches"); // [["a"], ["b"], ["c"]]
```

A caller that loads its base facts lazily uses this to find out what to
load next. Evaluate, read the demand rows on the relation whose base
facts come from somewhere else, fetch those, evaluate again, and stop
when no demand row is new. The rules then determine what gets loaded,
and the caller never has to guess how far a chain runs.

The fact sets one extraction produces run to thousands of tuples. If
they grow far past that, replace this evaluator and keep the rule data
model.
