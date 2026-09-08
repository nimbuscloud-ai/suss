# How an adapter teaches the evaluator its language

The reference for `@suss/values`: writing a lowering, writing rows, and the bounds the engine keeps to. The [README](./README.md) says what the package is for.

## Writing a lowering

A `Lowering<N>` is generic over the adapter's node type. The engine
never inspects a node; it only asks the lowering about it.

```ts
interface Lowering<N> {
  expression(node: N): Expression<N>;
  statement(node: N): Statement<N>;
  siteOf(node: N): Site<N> | null;
  functionOf(node: N): FunctionShape<N> | null;
  writtenTo(node: N): N | null;
  callable(node: N): N | null;
  mutatedInNestedFunction(root: N, name: string): boolean;
  freeNamesOf(fn: N): readonly string[];
  holeNameOf(node: N): string;
  readonly rows: readonly Row[];
}
```

`siteOf` gives the root and the path of statements from the root's body
down to the one containing the node. The path includes the node itself
when its parent is the root, so a function placed in a module body has a
path of its own. `functionOf` gives a function's parameters, each with
the expression it defaults to or null, and its body, and a module's body
as a function with no parameters. Anything the
lowering cannot express is `opaque`, and the engine gives it a hole
named by `holeNameOf`.

The engine asks `writtenTo` and `callable` only when it needs them, so
an adapter can back them with its resolution facts without paying for
nodes nobody asks about.

## Writing rows

A row says what one operator or library call does to abstract values.
Rows are the only place library knowledge lives.

```ts
{ kind: "operator", operator: "+", arity: 2, apply: ([a, b]) => plus(a, b) }
{ kind: "method", method: "push", on: "sequence",
  apply: ({ receiver, args }) => ({ result: constant(0), receiver: appended(receiver, args) }) }
{ kind: "callee", origin: { module: "path", name: "join" },
  apply: ({ args }) => ({ result: joinedPath(args) }) }
```

A method row matches on the method name and the receiver's kind. A
callee row matches on the import origin the lowering resolves, so a
local function spelled like a library function does not match. A row
that changes its receiver in place returns the new content as
`receiver`, and a row that hands back the receiver itself returns
`"receiver"` so a chain keeps its identity. The receiver arrives as its
content, but an array or record argument arrives as a `ref`, so `push`
keeps the identity of what it stores. A row that copies instead, the
way `concat` does, calls `contentOf(arg)` to read what is behind it.

`operations.ts` has the building blocks a row usually needs: `plus`,
`appended`, `extended`, `joined`, `equals`, `negated`, `fallback` and
`isPresent`.

## Spelling a route path

`pathOf` in `routePath.ts` turns a string value into the path a boundary
serves, and every adapter reads a route through it so a provider and a
consumer in different languages pair. A hole is spelled `{name}`, with
`?`, `+` or `*` after the name when it covers some other number of
segments, and a piece that is one of a few texts is spelled `(v1|v2)`.
An absolute URL loses its origin, and a query string or fragment ends
the path where it starts.

## Bounds

- `INLINE_DEPTH_CAP` limits how deep calls inline; past it a call is a
  hole.
- `STATEMENT_BUDGET` limits how many statements one `evaluate` runs;
  past it the run stops with the state it has. A caller can lower it
  through `EvaluatorOptions`.
- `SET_CAP` and `CONSTANT_CAP` limit how wide a set of literals grows.

## Testing

`testLowering.ts` is a small language whose nodes are plain objects with
their lowered shape written in, with parent links filled in by
`module()`. The engine tests are written against it, so a change to
the engine can be checked without any adapter.
