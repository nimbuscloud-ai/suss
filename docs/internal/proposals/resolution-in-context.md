# Proposal: resolution in every context

Status: direction decided (2026-08-05). Seam order below is the
scope; the context change itself is small.

## The same question at every seam

The rule this week established: before claiming a source does not name
something, ask the resolution store what the expression is written as.
The SQS recognizer follows it now:

```ts
const named = channelNamedBy(expr);              // literal, or process.env.X
if (named !== null) return sendEffect(named);
const resolved = ctx.resolveWrittenValue(expr);  // follows const + import
return sendEffect(resolved ? channelNamedBy(resolved) : null);
```

The same question goes unasked everywhere else, and it is not
hypothetical. Shipping today: `@Controller(BASE_PATH)` with the
constant imported from another file produces a route missing its
prefix, because a non-literal decorator argument becomes an empty
string and the empty prefix is silently skipped. Wrong, not unnamed,
and it pairs with the wrong client. The fuzzer's pinned queue-consumer
bugs (a subject held in a const, a shared subjects map) are the same
question at the discovery seam. Status-code extraction for four packs,
client URL and method extraction, resolver-map keys, and storybook
component references all read identity from expressions and never ask.
Drizzle cannot ask: its recognizer function is written without the
context parameter.

## The change

`resolveWrittenValue` becomes a field on every context the adapter
hands out. Today it exists on the invocation-recognizer context only.
The terminal-extraction context and the sub-unit context carry no
resolver at all; discovery threads one but most branches ignore it.

Pack authors get one call instead of two steps. The helper kit
exports:

```ts
// try the direct match, then resolve once, then null. Never "".
const path = resolvedString(args[0], ctx);
```

The lazy path and the correct path become the same call, which is the
same trick as the builder throw: no policing, the easy thing is the
right thing.

## Cost, compatibility, adoption

- Contexts are structurally typed. Adding a field breaks no pack. A
  pack that ignores it behaves exactly as today.
- A new pack on an old host writes
  `ctx.resolveWrittenValue ?? (() => null)`, the pattern SQS ships.
- Speed is measured, not assumed: resolution fires only at identity
  sites, and the benchmark against main showed every difference
  inside run noise. The store pays for widening on null answers, so
  each newly asking seam gets a benchmark run before merge, same as
  the first one did.
- Enforcement is a test property, not review vigilance: each shape
  family's named-less variant (the name routed through a const one
  import away) fails any pack that stopped asking. The producer
  family already works this way.

## Seam order, mapped to known bugs

1. Decorated routes (the shipping prefix bug) and terminal status
   extraction (four packs at once).
2. Discovery subjects (retires the pinned QUEUE_BUGS class; the pins
   come out of `knownBugs.ts` as they fix, per that file's contract).
3. Client URL and method extraction.
4. Drizzle's recognizer gains the context parameter and drops its
   private one-hop resolver; prisma's delegate-in-a-variable gate
   asks instead of dropping.
5. Resolver-map keys and storybook component references.

## Relation to symbolic references

This is stage one of the direction already recorded: resolve what the
program states, null what it does not. Stage two, externalized
references groundable by contracts or scenario bindings, lands on one
uniform seam instead of twelve because of this change.
