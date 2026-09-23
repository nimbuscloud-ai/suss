# Proposal: resolution in every context

Status: direction decided (2026-08-05). The seam order below is the
scope, and the context change itself is small.

## The same question at every seam

We settled a rule this week: before deciding that a source leaves
something unnamed, ask the resolution store what the expression is
written as. The SQS recognizer follows it now:

```ts
const named = channelNamedBy(expr);              // literal, or process.env.X
if (named !== null) return sendEffect(named);
const resolved = ctx.resolveWrittenValue(expr);  // follows const + import
return sendEffect(resolved ? channelNamedBy(resolved) : null);
```

Nothing else asks that question, and one bug that follows from it ships
today. When `@Controller(BASE_PATH)` gets its constant from another
file, the route comes out missing its prefix. A decorator argument that
is not a literal becomes an empty string, and an empty prefix is
silently skipped. The route comes out wrong instead of unnamed, and it
pairs with the wrong client. The fuzzer's pinned queue-consumer bugs (a
subject stored in a const, a shared subjects map) are the same question
at the discovery seam. The same gap shows up in four packs that pull
out status codes, in the code that pulls out client URLs and methods,
and in resolver-map keys and storybook component references. All of
them read identity off expressions and never ask. Drizzle cannot ask,
because its recognizer function is written without the context
parameter.

## The change

`resolveWrittenValue` becomes a field on every context the adapter
hands out. Today it exists on the invocation-recognizer context only.
The terminal-extraction context and the sub-unit context have no
resolver at all, and discovery passes one through but most branches
ignore it.

Pack authors get one call instead of two steps. The helper kit
exports:

```ts
// try the direct match, then resolve once, then null. Never "".
const path = resolvedString(args[0], ctx);
```

The lazy path and the correct path become the same call. The builder
throw works the same way: nobody has to police it, because the easy
thing is also the right thing.

## Cost, compatibility, adoption

- Contexts are structurally typed. Adding a field does not break any
  pack. A pack that ignores it behaves exactly as today.
- A new pack on an old host writes
  `ctx.resolveWrittenValue ?? (() => null)`, the pattern SQS ships.
- We measured the speed instead of assuming it. Resolution fires only
  at identity sites, and the benchmark against main showed every
  difference inside run noise. The store does extra widening work when
  a lookup comes back null, so every seam that starts asking gets a
  benchmark run before it merges, the same as the first one did.
- A test property enforces this, so it does not depend on review. Every
  shape family has a variant where the name is not written out directly
  (it goes through a const one import away), and that variant fails any
  pack that stopped asking. The producer family already works this way.

## Seam order, mapped to known bugs

1. Decorated routes (the prefix bug that ships today) and pulling
   status codes out of terminals (four packs at once).
2. Discovery subjects. This retires the pinned QUEUE_BUGS class, and
   each pin comes out of `knownBugs.ts` as it is fixed, as that file's
   contract requires.
3. Pulling out client URLs and methods.
4. Drizzle's recognizer gains the context parameter and drops its
   private one-hop resolver, and the prisma gate that handles a
   delegate stored in a variable asks instead of dropping it.
5. Resolver-map keys and storybook component references.

## Relation to symbolic references

This is stage one of the direction already recorded: resolve what the
program states, and return null for what it does not. Stage two is
externalized references that contracts or scenario bindings can ground.
Because of this change, stage two lands on one uniform seam instead of
twelve.
