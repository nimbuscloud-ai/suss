# How an adapter describes its language to the evaluator

This document covers writing a lowering for `@suss/values`, writing rows, and the limits the engine keeps to. The [README](./README.md) says what the package is for.

## Writing a lowering

A `Lowering<N>` is generic over the adapter's node type. The engine
never inspects a node. It only asks the lowering about it.

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
  declaredValueOf?(node: N): Value | null;
  readonly rows: readonly Row[];
}
```

`siteOf` returns the root and the path of statements from the root's
body down to the one that contains the node. When the node's parent is
the root, the path includes the node itself, so a function placed in a
module body has a path of its own. `functionOf` returns a function's
parameters and its body. Each parameter comes with the expression it
defaults to, or null. For a module, `functionOf` returns its body as a
function with no parameters. Anything the lowering cannot express is
`opaque`, and the engine gives it a hole named by `holeNameOf`.

The engine calls `writtenTo` and `callable` only when it needs them, so
an adapter can back them with its resolution facts and pay nothing for
nodes nobody asks about.

When `writtenTo` finds nothing for a name or a member read, the engine
calls `declaredValueOf` before it falls back to a hole. A parameter
typed `"INSERT" | "UPDATE" | "DELETE"` has no value in the source, but
its type declares it is one of three. The lowering returns that set, and
`` `record.${op.toLowerCase()}` `` folds to three literals. TypeScript
reads the type off the checker, which follows a type alias or an enum
into another file. Python reads a `Literal[...]` annotation on a
parameter, through an alias the facts can follow. Ruby has no declared
types and leaves the method out. The engine never calls it for a call.
A call that comes back as a hole releases the arrays passed to it, and
a narrow return type tells the engine nothing about what the call did
to them.

## Writing rows

A row describes what one operator or library call does to abstract
values. Rows are the only place where knowledge about libraries lives.

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
`receiver`. A row that returns the receiver itself returns `"receiver"`,
so a chain keeps its identity. The receiver arrives as its content, but
an array or record argument arrives as a `ref`, so `push` keeps the
identity of what it stores. A row that copies instead, as `concat` does,
calls `contentOf(arg)` to read the content behind the ref.

`operations.ts` has the building blocks a row usually needs: `plus`,
`appended`, `extended`, `joined`, `equals`, `startsWith`, `negated`,
`fallback`, `isPresent` and `recased`. `recased` changes the case of
every literal in a set. `startsWith` reads only as much of a
concatenation's settled head as it needs, so it can still return an
answer for a value whose tail is unresolved.

## Spelling a route path

`pathOf` in `routePath.ts` turns a string value into the path a
boundary serves. Every adapter reads a route through it, so a provider
and a consumer in different languages pair. A hole is written `{name}`,
followed by `?`, `+` or `*` when it covers some other number of
segments. A piece that is one of a few texts is written `(v1|v2)`. An
absolute URL loses its origin, and a query string or fragment ends the
path where it starts.

## Bounds

- `INLINE_DEPTH_CAP` limits how deep calls inline. Past it, a call is a
  hole.
- `STATEMENT_BUDGET` limits how many statements one `evaluate` runs.
  Past it, the run stops with the state it has. A caller can lower it
  through `EvaluatorOptions`.
- `SET_CAP` and `CONSTANT_CAP` limit how wide a set of literals grows.
  `SET_CAP` is 16, so an enum of ordinary size survives as a set. For a
  declared type wider than that, a lowering gives a hole, so the hole
  keeps the name of what it stood for.
- `literalsOf` takes a cap from its caller, because two sets side by
  side multiply. Past the cap it returns null, and the caller reads the
  value as one pattern with holes instead of a list of literals.

## Testing

`testLowering.ts` is a small language whose nodes are plain objects with
their lowered shape written in. `module()` fills in the parent links.
The engine tests are written against it, so a change to the engine can
be checked without any adapter.
