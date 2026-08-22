# What an adapter owes the rules

`@suss/resolution` lists the facts a language adapter supplies and says
what each one means in a sentence. It does not say how to key one. The
TypeScript adapter answered that question years of commits ago, in its
own source, and nothing wrote the answer down.

Building the Python and Ruby adapters, five separate pieces went in
wrong for that one reason. Each was already answered in
`adapter/typescript/src/facts/extract.ts`.

| What went in wrong | What TypeScript already did | How it surfaced |
| --- | --- | --- |
| A list was one opaque value | Elements under positional keys, so one property rule covers `items[0]` | Review, before merge |
| The rules were evaluated in full | `deriveOnDemand`, with full evaluation behind an env var | Self review, after merge |
| A call emitted no `writtenValue` | A call is a written value, so a chain can end at one | Hours of debugging a chain that derived nothing |
| A parameter keyed by file and name | Keyed by the parameter's own node | Review, after merge |
| Every value keyed by file and name | Every value keyed by the node that declares it | Review, after merge |

Three of those five reached main. One of them, evaluating in full, cost a
tenfold slowdown on a 417 file service. None of them were hard questions.
They were all answered, in one file, that a person building a new adapter
has no reason to know to read.

## What the contract is

Six rules, which are what the TypeScript adapter does. None of this is
new behaviour; it is what is already true, written where a second
adapter author will find it.

**A value is the node that declares it.** Not its name. Two functions in
one file that both take a `loader` declare two values, and a name that
shadows another is a different value from the one it shadows.

**A read is its own node, linked to its declaration.** `binds(reference,
declaration)` is what joins them. A reader that keys both sides by name
gets the same answer only where a name happens to be unique, which is
most of the time in a small test and rarely in a whole file.

**A name appears in exactly one place.** `exportsAs(file, name, node)`,
because a module genuinely exports under a name. Everywhere else a name
is a value key, something has gone wrong.

**A call is a written value and gets no `comesTo`.** A chain ends at a
call, and `isWrittenAs` is what reads one back. This is deliberate: a
factory call usually is the wrapper, and answering with what it returns
would fight the unwrapping answer.

**A sequence keeps its elements under their positions.** An array, a
list, a tuple: `objectValue` plus `holdsProperty` with the position as
the key, so a property rule covers indexed access with no second rule.

**Derivation is demand driven.** Ask with `wanted`, evaluate the
rewritten program. Both give the same answers and differ only in how
much never gets derived at all.

## How it is enforced

Writing it down is the smaller half. An adapter author reads the wrong
thing or reads nothing, and prose does not fail a build.

**A conformance kit an adapter runs.** Small programs in the adapter's
own language, each with the facts it must produce, as a test suite the
adapter imports. Something like:

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

Every one of the five above fails such a suite. The suite is written
once and each adapter supplies the source for each case, which is the
only part that differs by language.

**A branded value key.** `ValueKey` produced only by `declarationKey(node)`,
so a hand-built string does not typecheck. That kills the two keying
mistakes at compile time rather than at review.

The kit is worth more than the type. The type stops one class of error;
the kit states the semantics and catches drift when a rule changes
meaning.

## Where it lives

The kit belongs beside the rules it tests against, in `@suss/resolution`
or next to it, because the contract is the rules' contract rather than
any adapter's. The TypeScript adapter runs it too, and where it disagrees
with the kit, the kit is what needs correcting, since TypeScript is the
adapter the contract was read off.

## What this does not settle

Whether a general argument-to-parameter rule belongs in the shared rules.
A parameter takes whatever any caller passes, so the relation is
multi-valued, and a reader taking the first answer is wrong wherever a
function has two call sites. That is a design question about soundness
rather than a contract question, and the measured corpus needs an answer
to it.
