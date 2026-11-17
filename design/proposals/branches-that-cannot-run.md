# Branches that can no longer run

A refactor renames a helper and makes it return an empty object where it used to return `null`:

```ts
export async function loadOrder(id: string): Promise<Order> {
  const row = await db.order.findUnique({ where: { id } });
  return row ? toOrder(row) : ({} as Order);
}

app.get("/orders/:id", async (req, res) => {
  const order = await loadOrder(req.params.id);
  if (!order) {
    return res.status(404).json({ error: "order not found" });
  }
  return res.json(order);
});
```

Every value `loadOrder` returns is an object, and an object is always truthy, so the route can no longer respond 404. `inspect --diff` used to show the 404 outcome unchanged apart from the helper's name. It now says the outcome can no longer happen, and why.

## What the summary records

A transition whose conditions can never all be true keeps its place in the summary and gains an optional `unreachable` field:

```json
"unreachable": { "condition": 0, "values": { "type": "record", "properties": {} }, "every": "truthy" }
```

`condition` is the position of the condition that can never be true. `values` is every value that condition's subject can have, as a type shape, and `every` says what the language makes of each of them. The field only adds information, so the summary format stays at version 7. The checker does not read it yet.

## How a condition is settled

An adapter asks the value evaluator about a condition only when it tests a value's truth (`x`, `!x`, `not x`) and its subject is not read off an input. It evaluates the condition and its subject in a new sound mode. A plain evaluator returns the value a reader of the source would want: it reads a fallback over an unknown value as the fallback, and reads a name at the place its function is written. A sound evaluator returns a value only when that value covers every run, and a hole otherwise. In sound mode the engine:

- reads only names bound in the function it is running or in the functions it inlines, and only names the lowering says are written exactly once (`writtenOnce`). A parameter nobody passed, a name from outside, a member and a declared type are holes.
- inlines only a call the lowering resolves exactly: by plain name, to the function declared under that name, not async unless awaited, not a generator, not decorated, and only when the engine binds its arguments the way the language does. A splat, a TypeScript `this` parameter, a TypeScript default (`undefined` takes it), and a Ruby call whose `key: value` arguments become a hash all leave the call unread. Ruby also needs the method's name to be defined once in the project, so no subclass can override it, and every `return` in it to be one the lowering reads.
- treats a `finally` or `ensure` that returns, which replaces the body's return, as opaque.
- treats a statement the lowering leaves opaque as one that may have returned anything and may have changed any object.
- widens an object passed to code it cannot see, everything inside it, and whatever a member read hands out, and keeps them widened. A loop widens every name and object it changed.
- joins two objects nothing else refers to into one, and widens two that something else refers to.
- keeps what a returning branch arm left in the objects it returns.
- gives up on a run that exceeds the statement budget.

A condition is marked when the evaluated condition settles to one truth value and that value contradicts what the transition needs. Any hole leaves it alone.

## The language rule

The engine no longer decides truth itself. Each lowering supplies `truthiness`, and the engine, the rows for `!`, `not`, `&&`, `||`, `and` and `or`, and the condition reader all use it.

| | false |
|---|---|
| JavaScript | `null`, `undefined`, `false`, `0`, `NaN`, `""` |
| Python | `None`, `False`, `0`, `""`, an empty dict, list or tuple |
| Ruby | `nil`, `false` |

Before this change every language settled branches by the JavaScript rule, which was wrong for Ruby's `0` and `""`, and no language counted an object as true. The plain evaluator uses the new rules too, so a route path or a status that depended on one of those can now settle where it used to join both arms.

## What is left out

- A constructed object is a hole in every language. In JavaScript `new X()` is always an object, and in Ruby `X.new` almost always is, so both are easy next steps. A Python instance needs its class and every base read for `__bool__` and `__len__`.
- Null checks (`x === null`, `x is None`, `x.nil?`) are not settled. They need sound equality rows.
- A dict or list a Python helper returns from two different names is widened, so its emptiness is unknown.
- The checker still counts an unreachable transition as one the provider can produce.
