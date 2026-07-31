# Fact-based resolution

Resolve indirection with a fact base and rules instead of one-off AST
walkers. An exported value reaches its implementing function through any
depth of aliasing, re-export barrels, wrapper factories, and `.bind`,
because each pattern is a rule and rules compose.

## The problem

The adapter has four bespoke resolution walkers, each capped at one hop:

- `discovery/factoryTracking.ts` follows `const x = factory(...)` one
  variable binding from a tracked import.
- `terminals/helperResolution.ts` follows a returned call into a local
  helper.
- `discovery/resolveImport.ts` matches aliased imports within one file.
  It does not chase re-exports.
- `.then` parameter binding follows one Promise hop.

They do not compose. Measured against a production serverless monorepo:
88% of Lambda handler exports sit behind wrapper factories
(`export const handler = createProtectedHandler(inner)`), and every SQS
producer imports the AWS SDK through an internal barrel package. suss
found 8 of 155 handlers in the largest service and zero SQS producers,
not because extraction is weak but because discovery never reaches the
function.

Each new pattern today means a new walker with its own scope rules, and
stacked patterns (a wrapped handler exported through a barrel) fail even
when each hop is individually supported.

## Design

Two layers, both in `packages/adapter/typescript/src/facts/`.

**Fact extraction** walks a source file once and emits flat tuples.
No resolution logic lives here; it records what is syntactically
present. Node identity is `file:startOffset`, and a side table maps ids
back to ts-morph nodes so the final answer is a `Node`.

    func(f)                      function/arrow/method declaration
    paramOf(f, k, p)             parameter k of f
    binds(x, y)                  x is declared as y, or x references y
    imports(local, m, name)      m is a project file path or package name
    exportsAs(file, name, v)
    reExports(file, name, m, sourceName)
    reExportsAll(file, m)
    call(r, callee)              r is the call expression itself
    callArg(r, k, a)
    calleeName(r, text)          for pack-declared wrappers
    bindCall(r, target)          f.bind(...)
    returnsValue(f, v)
    bodyCalls(g, c)              call inside g whose callee is c

**Rules** run to fixpoint in a small semi-naive evaluator (hand-rolled,
no dependency; nothing on npm is both maintained and small, and the
Soufflé-class engines are native binaries). The derived relation the
rest of suss consumes is `resolves(x, f)`: value x is, after every hop,
function f.

    resolves(f, f)  <- func(f)
    resolves(x, z)  <- binds(x, y), resolves(y, z)
    resolves(x, z)  <- imports(x, m, n), moduleExport(m, n, v), resolves(v, z)
    resolves(r, h)  <- bindCall(r, t), resolves(t, h)
    resolves(r, h)  <- call(r, c), resolves(c, f), unwraps(f, k),
                       callArg(r, k, a), resolves(a, h)
    resolves(r, h)  <- calleeName(r, n), unwrapsByName(n, k),
                       callArg(r, k, a), resolves(a, h)

    moduleExport(m, n, v)  <- exportsAs(m, n, v)
    moduleExport(m, n, v)  <- reExports(m, n, m2, n2), moduleExport(m2, n2, v)
    moduleExport(m, n, v)  <- reExportsAll(m, m2), moduleExport(m2, n, v)

    returnsFunc(f, g)  <- returnsValue(f, v), resolves(v, g)
    unwraps(f, k)      <- returnsFunc(f, g), bodyCalls(g, c),
                          binds(c, p), paramOf(f, k, p)

`unwraps(f, k)` is the wrapper-transparency judgment: f returns a
function whose body calls f's parameter k, so a call to f resolves to
argument k. That covers project-local factories with no configuration.
For opaque library wrappers a pack declares the fact directly
(`transparentWrappers: [{ callee: "Sentry.wrapHandler", argument: 0 }]`),
which feeds `unwrapsByName`.

**Consumers** ask two questions:

- `resolveCallable(node)`: the function this value resolves to, if any.
  Wired into `namedExport` discovery for export values that are not
  directly a function.
- `importsTransitively(file, packages)`: whether a file reaches any of
  the named packages through its imports, following project-local
  re-export chains. Wired into the `requiresImport` gate, which today
  reads only the file's own import specifiers and is defeated by
  barrels.

Facts for a file are extracted on demand and only along the module
edges a query actually follows, so the full-project cost stays
proportional to the indirection present, not to project size. The gate
uses a lighter tier that extracts import and re-export facts only.

## What this absorbs

`factoryTracking` and `resolveImport` become fact extraction plus rules;
their bespoke traversals are deleted once callers migrate.
`helperResolution`'s traversal becomes the shared `unwraps` derivation.
The `.then` binding stays where it is (it feeds shapes, not discovery)
until a later pass.

## Out of scope for v0

Class-method delegation (following `handleChannelQuery` out of a
handler body into a class) is the next phase; it adds `methodOf` facts
and rules but no engine changes. Scope-sensitive dataflow, reassignment,
and conditional exports stay out; the fact layer over-approximates and
discovery's downstream filters keep precision.

## Acceptance

Fixtures per pattern: alias chain, re-export barrel, `export * from`,
local wrapper factory, two stacked wrappers, pack-declared wrapper,
`.bind`, and a wrapper imported through a barrel (composition). On the
production monorepo: handler discovery in the largest service goes from
8 to roughly 150, and SQS producer recognition stops being zero.
