# Proposal: subject identity as a derived relation

Status: draft, seeking alignment. The matrix below is measured; nothing
else is built.

## The class of bug

Discovery keeps asking one question with a hand-written scan: which
expressions in this project are the app, the router, the client, the
thing built by calling what `hono` or `express` exports. That answer
decides which `.get(...)` calls are routes, which `.use(...)` calls are
mounts or wrappers, and which calls are client sends.

`registrationSubjectsOf` answers it by enumerating spellings: a
top-level `const` initialized by the imported constructor, and a
parameter whose type annotation is the imported class. Every spelling
it does not enumerate is a route that silently does not exist. Ten
spellings of the same three-line Express app, on main today:

| where `const app = express()` is written | found |
|---|---|
| module scope | yes |
| inside a function | no |
| inside an arrow | no |
| inside a block | no |
| inside an IIFE | no |
| inside a class method | no |
| inside a try | no |
| a class property, used as `this.app.get(...)` | no |
| destructured, `const { app } = deps` | no |
| a property, `bag.server.get(...)` | no |

One of ten. #741 fixes six by widening the scan and asking the store
about parameters, and the remaining three are the same story at the
next spelling. Enumerating spellings loses to the language: every
feature a language has for moving a value is a place a subject can be
written, so the list is never done, and each miss costs whole routes.
#737's conditionally-assigned config and the factory-call middleware
from #726 are the same class in other clothes.

## The inversion

Ask from the other end. Constructions are few and easy to find: a call
or `new` whose callee comes from the declared module and name. What
discovery needs is everything that comes to one of those values, and
`comesTo` is already the engine's central closure. It follows a
binding, an import, a re-export, a property read, an argument into a
parameter, a factory's return. Every hop it learns, every consumer of
this question gets at once.

So the question becomes one derived relation:

```
subject(x, module, name) :-
  comesTo(x, c),
  construction(c, callee),
  comesFrom(callee, module, name).
```

`construction(c, callee)` says only that `c` is a call or a `new`
expression and `callee` is what it invokes. Nothing about it is
specific to apps: every call is a construction at the fact level, and
the join against `comesFrom` is what makes one a subject seed. The
adapter already emits `call` and callee facts, so this is likelier a
view over those than a new relation; the one genuine addition is `new`
expressions, which nothing records today. The demand is and seeded per (module, name) a pack declares, the way `wanted` seeds
every other question.

The fact layer already covers all ten rows. A class property binds its
initializer through `emitFieldValues`, a destructured name emits
`readsProperty`, an object property emits `holdsProperty`, a parameter
joins through `passesArgument` once #741's call facts land. The rows
fail today only because discovery scans syntax instead of asking.

## Who asks it

- `registrationSubjectsOf` becomes a membership check against the
  store, keeping a syntactic fast path for the file-local case the way
  the import readers kept theirs in 0.20.0's step 7.
- `mountPrefix` and `wrapperIndex` already key on subject ids from that
  one function, so they inherit the answer unchanged.
- `clientCall`'s "resolves to a known instance" is the same question
  about a client library, asked today through its own path.

## Across languages

The Python adapter's own header says it: the relation names and shapes
come from `@suss/resolution`, so a Python value follows the same rules
a TypeScript one does. Python already emits `binds`, `holdsProperty`
and `paramOf`. A FastAPI router built inside an app factory is the
same bug with the same fix, and the rule is shared; each adapter owes
only its `construction` fact and whatever base facts its language has
not emitted yet. That is the reason the facts-and-rules direction was
worth it: ten spellings times three languages is thirty walker cases,
and it is one rule.

## The gate

The ten-position matrix becomes an acceptance journey per language,
one file per position, asserting the route comes out with its path.
A position nobody supports is a visible `no` in a table rather than a
surprise on a field service, and a regression fails CI. Positions
grow as spellings turn up in the field; #737's guarded assignment and
lazy singleton join the table rather than staying their own issue.

## Cost

Demand stays scoped: constructions for a handful of (module, name)
pairs, and the closure runs over facts extraction already emits.
#741 measured +7% wall for the call facts, which this reuses without
adding a second pass. The membership check replaces a per-file scan,
so the marginal cost of the rule itself should be small; measure it
on the dogfood pass before and after, like every step of the 0.20.0
order.

## Order

1. The `construction` fact and the `subject` rule, behind the existing
   store. The TypeScript matrix as the gate. `registrationSubjectsOf`
   asks the store; #741's widened scan stays as its fast path.
2. The remaining three rows, which should fall out of step 1; any that
   does not is a missing base fact, fixed in the fact layer.
3. Python and Ruby: emit `construction`, point their discovery at the
   shared question, and run their own matrix.
4. Retire the per-feature copies: `clientCall`'s instance check, and
   whatever #674's consolidation finds still scanning.

#737's two readings extend `comesTo` afterward and every consumer of
`subject` gets them for free, which is the point of the shape.
