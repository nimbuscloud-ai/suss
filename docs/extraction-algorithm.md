# Extraction Algorithm

How the TypeScript adapter turns a function AST into a `RawCodeStructure`. This is the central piece of Phase 2, everything downstream assumes this pipeline produces correct output.

## Overview

For each code unit, extraction runs in five composable steps:

<svg class="suss-diagram" viewBox="0 0 660 388" role="img" aria-labelledby="algo-title algo-desc">
  <title id="algo-title">The five extraction steps</title>
  <desc id="algo-desc">Terminals are found first, using the pack's patterns. Each terminal then runs through three steps that walk the AST alone, and one that resolves symbols through the type checker, before being assembled into a raw branch.</desc>

  <defs>
    <marker id="algo-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
      <path class="arrow-head" d="M0,1 L7,4 L0,7 Z" />
    </marker>
  </defs>

  <rect class="box-data" x="230" y="8" width="200" height="30" rx="5" />
  <text class="label" x="330" y="28" text-anchor="middle">One function's AST</text>
  <line class="arrow" x1="330" y1="38" x2="330" y2="58" marker-end="url(#algo-arrow)" />

  <rect class="box" x="150" y="64" width="360" height="46" rx="6" />
  <text class="label" x="330" y="83" text-anchor="middle">1. Find the terminals</text>
  <text class="note" x="330" y="100" text-anchor="middle">every place this function produces an output, per the pack</text>
  <line class="arrow" x1="330" y1="110" x2="330" y2="130" marker-end="url(#algo-arrow)" />

  <rect class="box-data" x="215" y="136" width="230" height="30" rx="5" />
  <text class="label" x="330" y="156" text-anchor="middle">A list of terminals</text>
  <line class="arrow" x1="330" y1="166" x2="330" y2="186" marker-end="url(#algo-arrow)" />

  <text class="axis" x="348" y="181" text-anchor="start">for each one</text>

  <rect class="box" x="140" y="192" width="380" height="130" rx="6" />
  <text class="label" x="330" y="212" text-anchor="middle">2. Enumerate every path from entry to it</text>
  <text class="label" x="330" y="232" text-anchor="middle">3. Read the conditions along each path</text>
  <text class="note" x="330" y="250" text-anchor="middle">a pure walk of the statement tree, one branch per path</text>
  <line class="seam" x1="160" y1="262" x2="500" y2="262" />
  <text class="label" x="330" y="282" text-anchor="middle">4. Turn each condition into a predicate</text>
  <text class="note" x="330" y="299" text-anchor="middle">the only step that asks the type checker anything,</text>

  <text class="note" x="330" y="314" text-anchor="middle">so the expensive one and the language-specific one</text>

  <line class="arrow" x1="330" y1="322" x2="330" y2="340" marker-end="url(#algo-arrow)" />
  <rect class="box" x="140" y="346" width="380" height="30" rx="5" />
  <text class="label" x="330" y="366" text-anchor="middle">5. Assemble a branch, one per terminal</text>

</svg>

Steps 2 and 3 are pure AST traversal, no framework knowledge, no symbol resolution. They can be tested in isolation with tiny fixture functions.

Step 4 is where symbol resolution kicks in via ts-morph's type checker. It's the most language-specific piece and the most expensive in terms of compiler calls.

Each step lives in its own file (`paths/pathConditions.ts` for the path engine, `conditions.ts` for the expression-level walker it composes, `predicates.ts`, `subjects.ts`, `terminals/`). They compose, but they don't call each other directly, composition happens in `assembly.ts`.

This document covers per-function extraction. The whole-program passes that run after it (reachable closure, re-throw enrichment, boundary effects) are rules over a shared fact database, documented in [`internal/facts-and-rules.md`](internal/facts-and-rules.md).

## Step 1: `findTerminals`

**Input:** a function AST node + a list of `TerminalPattern` from the framework pack
**Output:** a list of `{ node, terminalData }` pairs

Walk every descendant of the function node. For each descendant, try to match it against each `TerminalPattern` in order. On a match, extract the terminal data using the pattern's `extraction` rules and record the pair.

```
findTerminals(func, patterns):
    results = []
    func.forEachDescendant(node => {
        for pattern in patterns:
            if matchTerminal(node, pattern.match):
                data = extractTerminalData(node, pattern.extraction)
                results.push({ node, data, kind: pattern.kind })
                break  // one terminal per node
    })
    return results
```

**Pattern match types:**

- **`returnShape`**: the node is a `ReturnStatement` returning an object literal, optionally with required properties. For ts-rest: `requiredProperties: ["status", "body"]` means the return must be `return { status: ..., body: ... }`.
- **`parameterMethodCall`**: the node is a call expression on a specific parameter, with a specific method chain. For Express: `parameterPosition: 1, methodChain: ["status", "json"]` matches `res.status(X).json(Y)`.
- **`throwExpression`**: the node is a `ThrowStatement`, optionally requiring the thrown expression text to match a constructor pattern. A project names its own helper, and `constructorPattern: "notFound"` then matches `throw notFound(...)`.

**Extraction:**

Given a matched terminal node, apply the `extraction` rules to pull out status code and body:

- `{ from: "property", name: "status" }`: read the `status` property from the object literal. If it's a numeric literal, produce `{ type: "literal", value: N }`. Otherwise `{ type: "dynamic", sourceText }`.
- `{ from: "argument", position: 0 }`: read the first argument of the matched call.
- `{ from: "constructor", codes }`: look the thrown expression's constructor name up in the pack-supplied `codes` map (full text first, then last dot-segment). Only fires for `throwExpression` matchers.

### Step 1b: `extractShape`: three-pass body-shape extraction

Response bodies and return values are extracted into `TypeShape` (see `ir-reference.md#typeshape`). The adapter runs three passes in order, stopping at the first that succeeds:

1. **Syntactic decomposition.** Object literals, array literals, and primitive literals decompose directly from the AST. This preserves *literal narrowness* that the type checker would widen: `return { status: "success" }` records `status` as `{ type: "literal", value: "success" }`, not `text`. Negative numerics (`-3`) and unary plus fold into the literal with signed `raw` text. Numeric literals carry `raw` so hex / scientific / separators / integers past `Number.MAX_SAFE_INTEGER` survive the IEEE 754 coercion.

2. **AST resolution.** For terminal nodes that aren't literals, bare identifiers, property access chains, destructuring bindings, local single-return function calls, the adapter walks back to the defining value and re-enters `extractShape` on that. This lets `const kind = "success"; return { kind }` still produce a literal shape even though the use-site type checker would have widened `kind` to `string`. The walker only recurses into initializers that are *syntactically informative*, literals, aggregate literals, ternaries, identifier / property chains. Call / await / `new` initializers skip this pass, because their declaration-site type is typically wider than use-site flow narrowing (e.g. `const user = await db.find()` returns `T | null`, but past a null guard the use site is just `T`).

3. **Type-checker fallback.** Anything the first two passes can't resolve is handed to ts-morph's type checker via `shapeFromNodeType`. This catches identifiers whose declarations live across module boundaries, generics, and types without literal initializers. The type checker sees flow narrowing at the reference site, so narrowed unions collapse correctly here. Opaque named types (`Date`, `Promise`, `Map`, `Error`, …) stop at `{ type: "ref", name: "Date" }` rather than expanding their structural properties, since the wire form is codec-dependent and the structural expansion would be misleading. Index-signature types (`Record<string, T>`, `{ [key: string]: T }`) with no named properties become `{ type: "dictionary", values: ... }`.

**Spreads.** `{ ...user, admin: true }` runs the spread expression through the same three-pass pipeline. A resolvable `record` result is merged in source order (later keys / later spreads override); only unresolvable spreads fall through to the `record.spreads[]` escape hatch. `union` spreads (e.g. a value narrowed to `record | null` where the caller would have flow-narrowed to `record`), we currently treat these as unresolvable, matching the conservative "some extra fields could be anything" semantics.

**Recursion and cycles.** Both the type-checker walk and the AST walker bound recursion: the type walker caps at depth 6 and tracks already-expanded type identities; the AST walker caps at 8 hops and tracks node identities. Cyclic `const a = a` (and deeper variants) terminate at a `ref`.

## Steps 2+3: CFG path conditions

Steps 2 and 3 are computed by the path engine (`paths/pathConditions.ts`), the only condition engine. It enumerates every entry→terminal control-flow path over the function's statement flow and emits **one RawBranch per path**: a terminal reached along several paths becomes several transitions, each carrying its true condition conjunction. This is correctness principle #1 implemented literally, and it is what closed the nested-guard and loop-return soundness gaps (see decisions #56 through #59 in `internal/status.md`):

- `if (a) { if (b) return X; } Y` → Y gets the paths `[¬a]` and `[a, ¬b]`, never a fabricated `¬a ∧ ¬b` or an empty list;
- sibling guards inside a block gate their tails (`if (a) { if (b) return X; T }` → T gets `[a, ¬b]`);
- `if (a) {…} else { return; } T` → T gets `[a]` (else-exit closure);
- terminals inside loops carry an opaque "some iteration" condition and post-loop terminals an opaque "loop exited" negation; quantified-over-iterations facts are not statically decidable, so the engine under-specifies rather than fabricates;
- dead-code terminals (no entry path) produce no transitions.

Expression-level branching *below* a statement (ternaries, `&&`/`||`, case clauses inside nested callbacks) is appended from the scoped ancestor walker in `conditions.ts`: the path engine walks statements, the walker covers the expression tree beneath them.

The engine's fidelity is verified mechanically by the differential fuzzer (`tools/differential`; see [`internal/differential-fuzzing.md`](internal/differential-fuzzing.md)).

### What the engine models

The whole structured statement language: `if`/`else`, `switch` (case groups, trailing breaks, fallthrough into an empty clause), all loop forms, `try`/`catch` (plus `finally` when it's pure cleanup), `break`/`continue`, `return`/`throw`, and expression-bodied arrows. Two constructs deliberately abstain rather than claim:

- **Loops.** Whether a condition held *on some iteration* is not statically decidable, so in-loop terminals carry an opaque "some iteration of:" condition and post-loop terminals an opaque "loop exited" negation. Under-specified, never fabricated.
- **Catch blocks.** Which statement threw is not statically decidable, so catch-body terminals carry a single opaque `catch` condition (`source: "catchBlock"`).

### Declined shapes degrade, never lie

A few shapes the engine does not model: labeled statements, `finally` blocks that exit or contain terminals, `switch` fallthrough into a non-empty clause, non-trailing `switch` breaks, and functions exceeding the 256-path budget. There is no second engine behind these. They **degrade**: each terminal keeps its enclosure conditions (the ancestor branches it sits inside, which gate it regardless of how the flow weaves) plus one opaque `unmodeled control flow (<reason>)` conjunct, so the transition honestly abstains from claiming a complete condition set. Under-specification over occasionally-wrong claims is correctness principle #2.

### Below statements: the expression-level walker

`collectAncestorConditionInfosBelow` (`conditions.ts`) walks from a terminal up to its containing statement and records the expression-level branching in between: ternary arms, `&&`/`||` short-circuits, and conditions inside nested callbacks that the statement-level enumeration doesn't see. The path engine appends these to each path's condition list. Same purity rule as the engine: AST only, no symbol table, no framework knowledge.

## Step 4a: `parseConditionExpression`

**Input:** a condition AST node (e.g., `!user`, `user.deletedAt`, `status === 200`)
**Output:** a `Predicate` structure, or null if the expression can't be decomposed

Pattern-match the expression node kind and build the corresponding `Predicate` variant:

```
parseConditionExpression(expr):
    match expr:
        PrefixUnaryExpression with "!" operator:
            inner = parseConditionExpression(expr.operand)
            if inner is truthinessCheck:
                return { ...inner, negated: !inner.negated }
            return { type: "negation", operand: inner }

        BinaryExpression:
            op = expr.getOperatorToken().getText()
            match op:
                "===", "!==", "==", "!=":
                    return {
                        type: "comparison",
                        left: resolveSubject(expr.getLeft()),
                        op: mapOp(op),
                        right: resolveSubject(expr.getRight()),
                    }
                ">", ">=", "<", "<=":
                    return {
                        type: "comparison",
                        left: resolveSubject(expr.getLeft()),
                        op: mapOp(op),
                        right: resolveSubject(expr.getRight()),
                    }
                "&&":
                    return {
                        type: "compound",
                        op: "and",
                        operands: [parseConditionExpression(expr.getLeft()),
                                   parseConditionExpression(expr.getRight())],
                    }
                "||":
                    return {
                        type: "compound",
                        op: "or",
                        operands: [parseConditionExpression(expr.getLeft()),
                                   parseConditionExpression(expr.getRight())],
                    }

        Identifier or PropertyAccessExpression:
            return {
                type: "truthinessCheck",
                subject: resolveSubject(expr),
                negated: false,
            }

        CallExpression:
            // e.g., isActive(user) or Array.isArray(x)
            return {
                type: "call",
                callee: expr.getExpression().getText(),
                args: expr.getArguments().map(resolveSubject),
            }

        TypeOfExpression or InstanceOfExpression:
            return {
                type: "typeCheck",
                subject: resolveSubject(expr.getExpression()),
                expectedType: extractTypeName(expr),
            }

        _:
            return null  // caller wraps as opaque
```

**Key invariant:** `parseConditionExpression` returns `null` (not an opaque predicate) when it can't decompose. The caller (`assembleBranch`) is responsible for wrapping null into an `opaque` predicate with the original source text. This keeps this function focused on structure and the assembly logic in one place.

**What should fall through to opaque:**

- Complex expressions with side effects
- Expressions involving `await` inside the condition
- Tagged templates and other dynamic string constructions
- Conditional expressions nested inside other conditions
- Any AST node kind this function doesn't recognize

## Step 4b: `resolveSubject`

**Input:** an expression node whose value is the subject of a condition
**Output:** a `ValueRef` structure

Trace the expression backward through the symbol table to find where its value originated.

```
resolveSubject(expr):
    match expr:
        Identifier:
            symbol = expr.getSymbol()
            if symbol is null:
                return { type: "unresolved", sourceText: expr.getText() }

            decl = symbol.getDeclarations()[0]

            if decl is ParameterDeclaration:
                return {
                    type: "input",
                    inputRef: decl.getName(),
                    path: [],
                }

            if decl is VariableDeclaration:
                init = decl.getInitializer()
                // Unwrap await
                if init is AwaitExpression:
                    init = init.getExpression()

                if init is CallExpression:
                    return {
                        type: "dependency",
                        name: init.getExpression().getText(),
                        accessChain: [],
                    }

                if decl is part of a BindingPattern (destructuring):
                    parentInit = findDestructuringSource(decl)
                    parentRef = resolveSubject(parentInit)
                    return {
                        type: "derived",
                        from: parentRef,
                        derivation: { type: "destructured", field: decl.getName() },
                    }

                // Other initializer — fall through to unresolved
                return { type: "unresolved", sourceText: expr.getText() }

            return { type: "unresolved", sourceText: expr.getText() }

        PropertyAccessExpression:
            objectRef = resolveSubject(expr.getExpression())
            return {
                type: "derived",
                from: objectRef,
                derivation: { type: "propertyAccess", property: expr.getName() },
            }

        NumericLiteral, StringLiteral, TrueKeyword, FalseKeyword, NullKeyword:
            return { type: "literal", value: parseLiteralValue(expr) }

        _:
            return { type: "unresolved", sourceText: expr.getText() }
```

**Why the shape is shallow:** `resolveSubject` doesn't try to understand what `db.findById` does or what it returns. It records "this value came from calling `db.findById`, and then we accessed `.repository.lastAnalyzedCommitHash`". That's enough for cross-boundary comparison to work, two predicates on different sides of a boundary can be recognized as testing the same thing, without the extractor needing to understand Prisma query semantics.

**Dependency on the compiler:** this is the most expensive step. Every identifier lookup goes through the symbol table. For a 500-line handler with 50 conditions, this can dominate extraction time. Two optimizations worth knowing about:

1. **Cache per-function**, within a single function, the same variable may be tested repeatedly. Cache `Identifier → ValueRef` lookups by node identity.
2. **Avoid project-wide reference search**, `findReferencesAsNodes()` walks the entire project and is quadratic in project size. Don't use it here; `getSymbol().getDeclarations()` is local and fast.

## Step 5: Assembly

Compose the outputs of steps 1-4 into a list of `RawBranch` (`assembly.ts`):

```
extractRawBranches(func, pack):
    terminals = findTerminals(func, pack.terminals)
    { byTerminal, fallthrough } = computePathConditions(func, terminals)

    branches = []
    for terminal in terminals:
        // A terminal with no entry path is dead code: no branches.
        for conditionList in byTerminal.get(terminal.node) ?? []:
            branches.push({
                conditions: conditionList.map(conditionInfoToRawCondition),
                terminal: terminal.data,
                location: terminal.data.location,
                isDefault: conditionList is empty
                    or every condition is source earlyReturn / earlyThrow,
            })
    return branches
```

Each `ConditionInfo` carries the condition's source text, polarity, and provenance (`explicit`, `earlyReturn`, `earlyThrow`, `catchBlock`); `conditionInfoToRawCondition` runs Step 4 on it (parse to `Predicate`, resolve subjects) and wraps what won't decompose as opaque.

Two post-passes follow in `assembly.ts`:

- **Fall-through synthesis.** When the pack opted in with a `functionFallthrough` terminal pattern and no existing terminal covers the default path, a synthetic terminal is added whose condition lists are the paths that fall off the body's end (`pathConditions`' `fallthrough` result). Pack opt-in keeps the semantics where they're declared: HTTP packs treat no-response as a gap, React event handlers treat implicit return as normal.
- **Effect attachment.** Bare expression-statement calls and recognizer-typed effects attach to the default branch, the path every body-top-level call executes on.

The `RawBranch[]` then flows to `assembleSummary()` in `@suss/extractor`, which handles the opaque-wrapping, gap detection, confidence scoring, and `expectedInput` pass-through. That logic is already implemented and tested, this document covers only the adapter side.

### Step 5b: Client field tracking

For client code units (discovered via `clientCall`), the adapter runs an additional step after branch extraction: trace which properties the consumer reads from the response variable within each branch.

```
collectClientFieldAccesses(callExpr, func, branchLocations):
    responseVar = findResponseVariable(callExpr)
    // e.g. "const res = await fetch(...)" → responseVar = "res"

    for each branch:
        subtree = findBranchSubtree(func, branch.location)
        accesses = collectPropertyAccesses(subtree, responseVar)
        // e.g. res.body.name → ["body", "name"]
        //      res.body.email → ["body", "email"]

        // Filter out status/ok/headers — we only want body-related accesses
        bodyAccesses = accesses.filter(not status/ok/headers)

        branch.expectedInput = buildShapeFromPaths(bodyAccesses)
        // → { type: "record", properties: { body: { type: "record",
        //     properties: { name: { type: "unknown" }, email: { type: "unknown" } } } } }
```

`expectedInput` flows through `RawBranch` → `assembleSummary` → `Transition.expectedInput`, where the checker's `checkBodyCompatibility` compares it against the provider's output body shape. Leaf types are `unknown` because we only track *which* fields are accessed, not what types the consumer expects, field presence is the comparison, not type compatibility.

## Testing strategy

The five steps correspond to five independently testable units:

| File | Tests |
|------|-------|
| `terminals.test.ts` | Fixture handlers in ts-rest / Express / React Router styles; assert the expected terminal nodes are found with correct extracted data. |
| `paths/pathConditions.test.ts` | Fixture functions with guards, nesting, `switch`, loops, `try`/`catch`, `break`/`continue`, and declined shapes. Assert each terminal's per-path condition lists (and the degraded form for declined shapes). |
| `conditions.test.ts` | The expression-level walker: ternaries, `&&`/`||`, conditions inside nested callbacks. Assert the recorded `ConditionInfo` list. |
| `predicates.test.ts` | Individual expression nodes (not full functions). Assert the parsed `Predicate`. One test per AST expression kind. |
| `subjects.test.ts` | Fixture functions with parameter access, dependency call results, destructuring, property chains. Assert the resolved `ValueRef`. |

Each test uses its own small fixture, no end-to-end runs for unit tests. Full extraction integration tests live in three places: the adapter's own integration test (`packages/adapter/typescript/src/*.test.ts` against `fixtures/ts-rest`), each framework pack's integration test (adapter-against-fixtures for its own framework), and the CLI test suite (deep-equal assertions on representative summaries per framework, plus `-o` round-trip).

Beyond fixtures, the correctness principles below are verified *mechanically* by a differential fuzzer (`tools/differential`): generated handler programs are extracted through the real pipeline and executed against request batteries, and any disagreement between the summary's claims and observed behavior is shrunk to a minimal counterexample. Constructs with documented soundness gaps run inverted properties that must keep rediscovering the gap until it's fixed. See [`internal/differential-fuzzing.md`](internal/differential-fuzzing.md).

## Correctness principles

Three properties must hold for the algorithm to be trusted:

1. **Exhaustiveness**, every path through the function body maps to exactly one `RawBranch`. If not, the missing path becomes a gap, not a silent drop.
2. **No false conditions**, a predicate that appears on a transition must actually gate that transition in the source code. It's fine to under-specify (fall back to opaque); it's not fine to report a condition that isn't really there.
3. **Stable subjects across renames**, `ValueRef`s should be structurally equal across mechanical renames. If a user renames `user` to `account`, the subject shape should still be `dependency("db.findById")` + property path, unchanged.

Violations of #1 degrade confidence but don't invalidate the summary. Violations of #2 or #3 are bugs and must be fixed.
