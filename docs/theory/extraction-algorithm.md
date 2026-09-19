---
title: Extraction algorithm
description: "The five steps that take one function AST to a raw code structure: terminals, paths, conditions, predicates and assembly."
---

# Extraction algorithm

The TypeScript adapter turns one function's AST into a `RawCodeStructure`, and every stage below it trusts that structure to be right.

For each code unit, extraction runs in five steps that compose:

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

Steps 2 and 3 walk the AST and nothing else: no framework knowledge, no symbol resolution. Each can be tested on its own with a tiny fixture function.

Step 4 resolves symbols through ts-morph's type checker. It is the most language-specific step and the one that makes the most compiler calls.

Each step lives in its own file: `paths/pathConditions.ts` for the path engine, `conditions.ts` for the expression-level walker it composes, then `predicates.ts`, `subjects.ts` and `terminals/`. None of them calls another directly. `assembly.ts` puts them together.

This page covers one function at a time. The whole-program passes that run afterward, the reachable closure, re-throw enrichment and boundary effects, are rules over a shared fact database; see [Facts and rules](/theory/facts-and-rules).

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
- **`throwExpression`**: the node is a `ThrowStatement`, optionally requiring the thrown expression text to match a constructor pattern. A project supplies the name of its own helper, so `constructorPattern: "widgetError"` then matches `throw widgetError(...)`.

**Extraction:**

Given a matched terminal node, apply the `extraction` rules to pull out status code and body:

- `{ from: "property", name: "status" }`: read the `status` property from the object literal. If it's a numeric literal, produce `{ type: "literal", value: N }`. Otherwise `{ type: "dynamic", sourceText }`.
- `{ from: "argument", position: 0 }`: read the first argument of the matched call.
- `{ from: "constructor", codes }`: look the thrown expression's constructor name up in the `codes` map the pack supplied (full text first, then last dot-segment). This only fires for `throwExpression` matchers.

### Step 1b: `extractShape`: three-pass body-shape extraction

Response bodies and return values are extracted into `TypeShape` (see [IR types](/reference/ir#typeshape)). The adapter runs three passes in order, stopping at the first that succeeds:

1. **Syntactic decomposition.** Object literals, array literals, and primitive literals decompose directly from the AST. This preserves *literal narrowness* that the type checker would widen: `return { status: "success" }` records `status` as `{ type: "literal", value: "success" }`, not `text`. Negative numerics (`-3`) and unary plus fold into the literal with signed `raw` text. Numeric literals include `raw`, so hex / scientific / separators / integers past `Number.MAX_SAFE_INTEGER` survive the IEEE 754 coercion.

2. **AST resolution.** For terminal nodes that aren't literals (bare identifiers, property access chains, destructuring bindings, local single-return function calls), the adapter walks back to the defining value and re-enters `extractShape` on that. This lets `const kind = "success"; return { kind }` still produce a literal shape even though the use-site type checker would have widened `kind` to `string`. The walker only recurses into initializers that are *syntactically informative*: literals, aggregate literals, ternaries, and identifier / property chains. Call / await / `new` initializers skip this pass, because their declaration-site type is usually wider than use-site flow narrowing (e.g. `const user = await db.find()` returns `T | null`, but past a null guard the use site is only `T`).

3. **Type-checker fallback.** Anything the first two passes can't resolve is handed to ts-morph's type checker via `shapeFromNodeType`. This catches identifiers whose declarations live in other modules, generics, and types without literal initializers. The type checker sees flow narrowing at the reference site, so narrowed unions collapse correctly here. Opaque named types (`Date`, `Promise`, `Map`, `Error`, …) stop at `{ type: "ref", name: "Date" }` instead of expanding their structural properties, because the wire form depends on the codec and the structural expansion would mislead the reader. Index-signature types (`Record<string, T>`, `{ [key: string]: T }`) with no named properties become `{ type: "dictionary", values: ... }`.

**Spreads.** `{ ...user, admin: true }` runs the spread expression through the same three-pass pipeline. A resolvable `record` result is merged in source order, so later keys and later spreads override earlier ones, and only an unresolvable spread falls through to the `record.spreads[]` escape hatch. A `union` spread counts as unresolvable too, say a value narrowed to `record | null` where the caller would have flow-narrowed it to `record`, which keeps the conservative reading that some extra fields could be anything.

**Recursion and cycles.** Both the type-checker walk and the AST walker bound recursion: the type walker caps at depth 6 and tracks already-expanded type identities; the AST walker caps at 8 hops and tracks node identities. Cyclic `const a = a` (and deeper variants) terminate at a `ref`.

## Steps 2+3: CFG path conditions

The path engine (`paths/pathConditions.ts`) computes steps 2 and 3, and it is the only condition engine. It enumerates every entry-to-terminal control-flow path over the function's statement flow and emits **one RawBranch per path**, so a terminal reached along several paths becomes several transitions, each with its own conjunction of conditions. That is the exhaustiveness principle below, implemented literally, and it closed the nested-guard and loop-return gaps. The hand-written condition collectors it replaced were unsound on the shapes they still served, and they have been deleted, so there is no fallback path:

- `if (a) { if (b) return X; } Y` → Y gets the paths `[¬a]` and `[a, ¬b]`, never a fabricated `¬a ∧ ¬b` or an empty list;
- sibling guards inside a block gate their tails (`if (a) { if (b) return X; T }` → T gets `[a, ¬b]`);
- `if (a) {…} else { return; } T` → T gets `[a]` (else-exit closure);
- terminals inside loops get an opaque "some iteration" condition, and post-loop terminals get an opaque "loop exited" negation. No static reader can decide what held on every iteration, so the engine says less rather than guessing;
- a dead-code terminal, one that no entry path reaches, never produces a transition.

Expression-level branching *below* a statement (ternaries, `&&` and `||`, case clauses inside nested callbacks) is appended from the scoped ancestor walker in `conditions.ts`. The path engine walks statements, and the walker covers the expression tree beneath them.

The engine's fidelity is verified mechanically by the differential fuzzer (`tools/differential`; see [the differential-fuzzing record](https://github.com/nimbuscloud-ai/suss/blob/main/design/docs-internal/differential-fuzzing.md)).

### What the engine models

It models the whole structured statement language: `if`/`else`, `switch` (case groups, trailing breaks, fallthrough into an empty clause), every loop form, `try`/`catch` (plus `finally` where it is only cleanup), `break`/`continue`, `return`/`throw`, and expression-bodied arrows. On two constructs it says nothing rather than guessing:

- **Loops.** No static reader can decide whether a condition held *on some iteration*, so an in-loop terminal gets an opaque "some iteration of:" condition and a post-loop terminal gets an opaque "loop exited" negation.
- **Catch blocks.** No static reader can decide which statement threw, so a catch-body terminal gets a single opaque `catch` condition (`source: "catchBlock"`).

### Callbacks the unit hands to its own calls

A nested arrow or function expression is part of the unit that wrote it unless a pack claimed it as a sub-unit. `walk/descent.ts` decides that once, and every pass asks it there: the recognizer walk, the invocation-effect walk, terminal discovery, and the statement lowering. So a `.then`, `.map`, or promise-executor callback contributes its branches to the unit the same way its calls already contributed their effects, and a route handler or event subscription a pack declared stays a unit of its own.

Its exits are its own, though. A `return` or a `throw` inside a callback ends the callback rather than the unit, so the enclosing path picks up again past the call and the code after it stays reachable. The callback's `return` never becomes one of the unit's terminals. In `fetch(u).then((r) => r.json())` the callback resolves the promise the unit returns, and treating that as a second exit would invent a transition that is not in the source.

### When a branch reaches the summary

A branch that rejoins leaves nothing behind on the terminals after it. `if (a) { log() } return X` gives X one unconditional path, because X is reached either way. `mergeRejoined` does that, and it is also what stops a run of guards multiplying. The paths a body hands back at the end are the exception: no statement follows them, so nothing merges them, and `if (res.ok) { toast.success() } else { toast.error() }` at the end of a function leaves two fall-through branches. The checker needs both to see a consumer discriminating on a status when neither arm returns.

### Shapes the engine declines

The engine does not model labeled statements, `finally` blocks that exit or contain terminals, `switch` fallthrough into a non-empty clause, non-trailing `switch` breaks, or a function past the 256-path budget. There is no second engine behind these. Each terminal keeps its enclosure conditions, the ancestor branches it is inside, which gate it however the flow weaves, plus one opaque `unmodeled control flow (<reason>)` conjunct. The transition then makes no claim to a complete condition set, which is the second correctness principle below.

### Below statements: the expression-level walker

`collectAncestorConditionInfosBelow` (`conditions.ts`) walks from a terminal up to its containing statement and records the expression-level branching in between: ternary arms, `&&`/`||` short-circuits, and conditions inside nested callbacks that the statement-level enumeration doesn't see. The path engine appends these to each path's condition list. The walker follows the same purity rule as the engine: AST only, no symbol table, no framework knowledge.

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

**Key invariant:** `parseConditionExpression` returns `null` (not an opaque predicate) when it can't decompose the expression. The caller (`assembleBranch`) is the one that wraps null into an `opaque` predicate with the original source text. That keeps `parseConditionExpression` focused on structure, and it keeps the assembly logic in one place.

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

                // Other initializer: fall through to unresolved
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

**Why the result stays shallow:** `resolveSubject` makes no attempt to understand what `db.findById` does or what it returns. It records that the value came from calling `db.findById` and that `.repository.lastAnalyzedCommitHash` was then read off it. Cross-boundary comparison needs no more than that: two predicates on either side of a boundary can be seen to test the same thing without the extractor understanding Prisma query semantics.

**Dependency on the compiler:** this is the most expensive step. Every identifier lookup goes through the symbol table. For a 500-line handler with 50 conditions, this can dominate extraction time. Two optimizations worth knowing about:

1. **Cache per function.** Within a single function, the same variable may be tested repeatedly, so cache `Identifier → ValueRef` lookups by node identity.
2. **Avoid project-wide reference search.** `findReferencesAsNodes()` walks the entire project and is quadratic in project size. Don't use it here; `getSymbol().getDeclarations()` is local and fast.

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

Each `ConditionInfo` records the condition's source text, polarity, and provenance (`explicit`, `earlyReturn`, `earlyThrow`, `catchBlock`). `conditionInfoToRawCondition` runs Step 4 on it (parse to `Predicate`, resolve subjects) and wraps whatever won't decompose as opaque.

Two post-passes follow in `assembly.ts`:

- **Fall-through synthesis.** When the pack opted in with a `functionFallthrough` terminal pattern and no existing terminal covers the default path, the adapter adds a synthetic terminal whose condition lists are the paths that fall off the end of the body (`pathConditions`' `fallthrough` result). Making the pack opt in keeps the semantics where they are declared: HTTP packs treat no-response as a gap, and React event handlers treat an implicit return as normal.
- **Effect attachment.** Every call in the body, wherever it is written, becomes an invocation effect, and it attaches to each branch whose path runs it: the call's preconditions must be true on the branch, and the call's statement must come before the branch's terminal (or the call runs on every path, as a `finally` body does). A call that is itself a terminal, or a link in a terminal's receiver chain, is dropped, since the terminal already records it. Recognizer-typed effects attach by the same two tests.

The `RawBranch[]` then flows to `assembleSummary()` in `@suss/extractor`, which handles the opaque-wrapping, gap detection, confidence scoring, and `expectedInput` pass-through. That logic is already implemented and tested. Only the adapter side is described here.

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

        // Keep only the body-related accesses, dropping status/ok/headers
        bodyAccesses = accesses.filter(not status/ok/headers)

        branch.expectedInput = buildShapeFromPaths(bodyAccesses)
        // → { type: "record", properties: { body: { type: "record",
        //     properties: { name: { type: "unknown" }, email: { type: "unknown" } } } } }
```

`expectedInput` flows through `RawBranch` to `assembleSummary` to `Transition.expectedInput`, where the checker's `checkBodyCompatibility` compares it against the provider's output body shape. Every leaf type is `unknown`, because the adapter records which fields a branch reads and stops there. What the comparison settles is field presence.

## Testing strategy

The five steps correspond to five independently testable units:

| File | Tests |
|------|-------|
| `terminals.test.ts` | Fixture handlers in ts-rest / Express / React Router styles; assert the expected terminal nodes are found with correct extracted data. |
| `paths/pathConditions.test.ts` | Fixture functions with guards, nesting, `switch`, loops, `try`/`catch`, `break`/`continue`, and declined shapes. Assert each terminal's per-path condition lists (and the degraded form for declined shapes). |
| `conditions.test.ts` | The expression-level walker: ternaries, `&&`/`||`, conditions inside nested callbacks. Assert the recorded `ConditionInfo` list. |
| `predicates.test.ts` | Individual expression nodes (not full functions). Assert the parsed `Predicate`. One test per AST expression kind. |
| `subjects.test.ts` | Fixture functions with parameter access, dependency call results, destructuring, property chains. Assert the resolved `ValueRef`. |

Each test uses its own small fixture, and unit tests never run end to end. Full extraction integration tests live in three places: the adapter's own integration test (`packages/adapter/typescript/src/*.test.ts` against `fixtures/ts-rest`), each framework pack's integration test (the adapter run against fixtures for that framework), and the CLI test suite (deep-equal assertions on representative summaries per framework, plus `-o` round-trip).

Beyond fixtures, a differential fuzzer (`tools/differential`) checks the correctness principles below mechanically. It extracts generated handler programs through the shipping pipeline, runs them against batteries of requests, and shrinks any disagreement between the summary's claims and the observed behavior down to a minimal counterexample. A construct with a documented soundness gap runs an inverted property that has to keep rediscovering the gap until somebody fixes it. See [the differential-fuzzing record](https://github.com/nimbuscloud-ai/suss/blob/main/design/docs-internal/differential-fuzzing.md).

## Correctness principles

Three properties must hold for the algorithm to be trusted:

1. **Exhaustiveness.** Every path through the function body maps to exactly one `RawBranch`. If it doesn't, the missing path becomes a gap, and it is never dropped silently.
2. **No false conditions.** A predicate that appears on a transition must actually gate that transition in the source code. Under-specifying is fine (fall back to opaque); reporting a condition that isn't there is not.
3. **Stable subjects across renames.** `ValueRef`s should be structurally equal across mechanical renames. If a user renames `user` to `account`, the subject should still resolve to `dependency("db.findById")` plus the same property path, unchanged.

Violations of #1 degrade confidence but don't invalidate the summary. Violations of #2 or #3 are bugs and must be fixed.
