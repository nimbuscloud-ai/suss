# Proposal: subject identity as a derived relation

Status: draft, seeking alignment. The matrix below is measured; nothing
else is built.

## The class of bug

Discovery keeps asking one question, and it asks it with a hand-written
scan: which expressions in this project are the app, the router, the
client, or anything else built by calling what `hono` or `express`
exports. The answer decides which `.get(...)` calls are routes, which
`.use(...)` calls are mounts or wrappers, and which calls are client
sends.

`registrationSubjectsOf` gets the answer by listing spellings: a
top-level `const` initialized by the imported constructor, and a
parameter whose type annotation is the imported class. Every spelling
it does not list turns into a route that silently goes missing. Here
are ten spellings of the same three-line Express app, run on main
today:

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

It finds one of ten. #741 fixes six by widening the scan and asking the
store about parameters, and the remaining three fail the same way at
the next spelling. A list of spellings cannot keep up with the
language. Every feature a language has for moving a value is a place a
subject can be written, so the list is never finished, and each miss
loses whole routes. The conditionally-assigned config in #737 and the
factory-call middleware from #726 are the same kind of bug in a
different form.

## Asking from the other end

Start from the construction. Constructions are few and easy to find: a
call or `new` whose callee comes from the declared module and name.
Discovery needs everything that comes to one of those values, and
`comesTo`, the engine's central closure, already computes that. It
follows a binding, an import, a re-export, a property read, an argument
into a parameter, and a factory's return. Every hop `comesTo` learns to
follow reaches every consumer of this question at once.

So the question becomes one derived relation:

```
subject(x, module, name) :-
  comesTo(x, c),
  construction(c, callee),
  comesFrom(callee, module, name).
```

`construction(c, callee)` records only that `c` is a call or a `new`
expression and that `callee` is what it invokes. Nothing about it is
specific to apps. Every call is a construction at the fact level, and
the join against `comesFrom` turns one into a subject seed. The adapter
already emits `call` and callee facts, so this is more likely a view
over those than a new relation. The one addition is `new` expressions,
which nothing records today. Demand is seeded per (module, name) a pack
declares, the way `wanted` seeds every other question.

The fact layer already covers all ten rows. A class property binds its
initializer through `emitFieldValues`. A destructured name emits
`readsProperty`, and an object property emits `holdsProperty`. A
parameter joins through `passesArgument` once #741's call facts land.
The rows fail today only because discovery scans syntax instead of
asking.

## Who asks it

- `registrationSubjectsOf` becomes a membership check against the
  store. It keeps a syntactic fast path for the file-local case, the
  way the import readers kept theirs in 0.20.0's step 7.
- `mountPrefix` and `wrapperIndex` already key on subject ids from that
  one function, so they inherit the answer unchanged.
- `clientCall`'s "resolves to a known instance" is the same question
  about a client library, asked today through its own path.

## Across languages

The Python adapter's header comment states it: the relation names and
signatures come from `@suss/resolution`, so a Python value follows the
same rules a TypeScript one does. Python already emits `binds`,
`holdsProperty` and `paramOf`. A FastAPI router built inside an app
factory is the same bug with the same fix, and the rule is shared. Each
adapter has to supply only its `construction` fact and whatever base
facts its language does not emit yet. That is why the move to facts and
rules paid off: ten spellings times three languages would be thirty
walker cases, and here it is one rule.

## The gate

The ten-position matrix becomes an acceptance journey per language,
with one file per position, asserting that the route comes out with its
path. A position nobody supports shows up as a `no` in a table instead
of a surprise on a field service, and a regression fails CI. New
positions get added as spellings turn up in the field. The guarded
assignment and lazy singleton from #737 join the table instead of
staying a separate issue.

## Cost

Demand stays scoped: constructions for a handful of (module, name)
pairs, and the closure runs over facts extraction already emits. The
call facts cost +7% wall time when #741 measured them, and this reuses
them without adding a second pass. The membership check replaces a
per-file scan, so the marginal cost of the rule itself should be small.
Measure it on the dogfood pass before and after, as with every step of
the 0.20.0 order.

## Order

1. The `construction` fact and the `subject` rule, behind the existing
   store, with the TypeScript matrix as the gate.
   `registrationSubjectsOf` asks the store, and #741's widened scan
   stays as its fast path.
2. The remaining three rows, which step 1 should fix with no extra
   work. Any row it does not fix points at a missing base fact, and
   that gets fixed in the fact layer.
3. Python and Ruby: emit `construction`, point their discovery at the
   shared question, and run their own matrix.
4. Retire the per-feature copies: `clientCall`'s instance check, and
   whatever #674's consolidation finds still scanning.

Afterward, the two readings from #737 extend `comesTo`, and every
consumer of `subject` gets them with no extra work. That is the reason
for building it this way.
