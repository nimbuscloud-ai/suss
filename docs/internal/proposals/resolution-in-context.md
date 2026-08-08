# Proposal: resolution in every context

Status: direction decided (2026-08-05). The seam order below is the
scope, and the context change itself is small.

## The same question at every seam

We settled a rule this week: before claiming a source does not name
something, ask the resolution store what the expression is written as.
The SQS recognizer follows it now:

```ts
const named = channelNamedBy(expr);              // literal, or process.env.X
if (named !== null) return sendEffect(named);
const resolved = ctx.resolveWrittenValue(expr);  // follows const + import
return sendEffect(resolved ? channelNamedBy(resolved) : null);
```

Nobody asks that question anywhere else, and this is not hypothetical.
One case ships today. When `@Controller(BASE_PATH)` gets its constant
from another file, the route comes out missing its prefix, because a
decorator argument that is not a literal becomes an empty string, and
an empty prefix is silently skipped. The route is wrong rather than
unnamed, and it pairs with the wrong client. The fuzzer's pinned
queue-consumer bugs (a subject stored in a const, a shared subjects
map) are the same question at the discovery seam. Four packs pulling
out status codes, the code that pulls out client URLs and methods,
resolver-map keys, and storybook component references all read identity
off expressions and never ask. Drizzle cannot ask: its recognizer
function is written without the context parameter.

## The change

`resolveWrittenValue` becomes a field on every context the adapter
hands out. Today it exists on the invocation-recognizer context only.
The terminal-extraction context and the sub-unit context have no
resolver at all, and discovery threads one through but most branches
ignore it.

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
- We measured the speed rather than assuming it. Resolution fires only
  at identity sites, and the benchmark against main showed every
  difference inside run noise. The store does extra work widening when
  it gets a null answer, so every seam that starts asking gets a
  benchmark run before it merges, the same as the first one did.
- A test property enforces this, not review vigilance. Every shape
  family has a variant where the name is not written out directly (it
  goes through a const one import away), and that variant fails any
  pack that stopped asking. The producer family already works this way.

## Seam order, mapped to known bugs

1. Decorated routes (the prefix bug that ships today) and pulling
   status codes out of terminals (four packs at once).
2. Discovery subjects (this retires the pinned QUEUE_BUGS class, and
   the pins come out of `knownBugs.ts` as they are fixed, which is what
   that file's contract says).
3. Pulling out client URLs and methods.
4. Drizzle's recognizer gains the context parameter and drops its
   private one-hop resolver, and the prisma gate that handles a
   delegate stored in a variable asks instead of dropping it.
5. Resolver-map keys and storybook component references.

## Relation to symbolic references

This is stage one of the direction already recorded: resolve what the
program states, and return null for what it does not. Stage two is
externalized references that contracts or scenario bindings can ground,
and because of this change it lands on one uniform seam instead of
twelve.
