# The facts an adapter must supply

`@suss/resolution` lists the facts a language adapter supplies and gives
a one-sentence meaning for each. It does not say how to key one. The
TypeScript adapter settled that in its own source long ago, and nobody
wrote the answer down.

While we built the Python and Ruby adapters, five separate pieces went in
wrong for that one reason. The answer to each was already in
`adapter/typescript/src/facts/extract.ts`.

| What went in wrong | What TypeScript already did | How it surfaced |
| --- | --- | --- |
| A list was one opaque value | Elements under positional keys, so one property rule covers `items[0]` | Review, before merge |
| The rules were evaluated in full | `deriveOnDemand`, with full evaluation behind an env var | Self review, after merge |
| A call emitted no `writtenValue` | A call is a written value, so a chain can end at one | Hours of debugging a chain that derived nothing |
| A parameter keyed by file and name | Keyed by the parameter's own node | Review, after merge |
| Every value keyed by file and name | Every value keyed by the node that declares it | Review, after merge |

Three of those five reached main. One of them, evaluating in full, made a
417 file service ten times slower. None of them were hard questions. The
answers were all in one file, and a person building a new adapter has no
reason to know they should read it.

## What the contract is

The contract is six rules, and the TypeScript adapter already follows all
of them. None of this is new behaviour. It is written here so that the
next adapter author finds it.

**A value is the node that declares it.** Its name does not identify it.
Two functions in one file that both take a `loader` declare two values,
and a name that shadows another is a different value from the one it
shadows.

**A read is its own node, linked to its declaration.** The fact
`binds(reference, declaration)` joins the two. A reader that keys both
sides by name gets the same answer only where the name happens to be
unique. That holds most of the time in a small test and rarely in a whole
file.

**A name appears in exactly one place.** That place is
`exportsAs(file, name, node)`, because a module does export under a name.
Anywhere else a name is used as a value key, something has gone wrong.

**A call is a written value and gets no `comesTo`.** A chain ends at a
call, and `isWrittenAs` reads the call back. We chose this on purpose. A
factory call usually is the wrapper, so returning what the factory
returns would conflict with the answer that unwraps it.

**A sequence keeps its elements under their positions.** For an array, a
list or a tuple, the adapter emits `objectValue` plus `holdsProperty`
with the position as the key. One property rule then covers indexed
access, and indexed access does not need a second rule.

**Derivation is demand driven.** Ask with `wanted` and evaluate the
rewritten program. Both ways give the same answers. The difference is
that on demand, much of the program never gets derived at all.

## How it is enforced

Writing the rules down is the smaller half. An adapter author reads the
wrong thing or reads nothing, and prose does not fail a build.

**A conformance kit an adapter runs.** The kit is a test suite the
adapter imports. Each case is a small program in the adapter's own
language, with the facts it must produce. Something like:

```
conformsToFactContract(adapter, {
  "two functions taking a parameter of one name": {
    source: /* the language's own spelling */,
    expect: { paramOf: distinctKeys(2) },
  },
  "a name bound to a call": {
    expect: { writtenValue: theCall, comesTo: none },
  },
})
```

Every one of the five mistakes above fails a suite like this. We write
the suite once, and each adapter supplies the source for each case. The
source is the only part that differs by language.

**A branded value key.** Only `declarationKey(node)` produces a
`ValueKey`, so a hand-built string does not typecheck. The two keying
mistakes then fail at compile time, before anyone reviews them.

The kit matters more than the type. The type stops one class of error.
The kit states what each rule means, and it catches drift when a rule
changes meaning.

## Where it lives

The kit belongs beside the rules it tests against, in `@suss/resolution`
or next to it, because the contract belongs to the rules and to no one
adapter. The TypeScript adapter runs the kit too. Where the adapter and
the kit disagree, fix the kit, since the contract was read off the
TypeScript adapter.

## What this does not settle

This does not settle whether a general argument-to-parameter rule belongs
in the shared rules. A parameter takes whatever any caller passes, so the
relation has many values. A reader that takes the first answer is wrong
wherever a function has two call sites. That is a design question about
soundness and does not belong in the contract. The measured corpus
still needs it settled.
