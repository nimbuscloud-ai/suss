# Extraction Algorithm

How the TypeScript adapter turns a function AST into a `RawCodeStructure`. This is the central piece of Phase 2 — everything downstream assumes this pipeline produces correct output.

## Overview

For each code unit, extraction runs in five composable steps:

```
function body AST
    │
    │  Step 1 — findTerminals
    │  (framework pack patterns)
    ▼
list of terminal AST nodes
    │
    │  For each terminal:
    │
    │    Step 2 — collectAncestorBranches
    │    (pure AST walk, no symbol resolution)
    │
    │    Step 3 — collectEarlyReturns
    │    (pure AST walk, no symbol resolution)
    │
    │    Step 4 — parseConditionExpression + resolveSubject
    │    (expression → Predicate, using the symbol table)
    │
    │    Step 5 — assemble RawBranch
    │
    ▼
RawBranch[]
```

Steps 2 and 3 are pure AST traversal — no framework knowledge, no symbol resolution. They can be tested in isolation with tiny fixture functions.

Step 4 is where symbol resolution kicks in via ts-morph's type checker. It's the most language-specific piece and the most expensive in terms of compiler calls.

Each step is a separate function in its own file (`branches.ts`, `earlyReturns.ts`, `predicates.ts`, `subjects.ts`, `terminals.ts`). They compose, but they don't call each other directly — composition happens at a higher level.

## Step 1 — `findTerminals`

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

- **`returnShape`** — the node is a `ReturnStatement` returning an object literal, optionally with required properties. For ts-rest: `requiredProperties: ["status", "body"]` means the return must be `return { status: ..., body: ... }`.
- **`parameterMethodCall`** — the node is a call expression on a specific parameter, with a specific method chain. For Express: `parameterPosition: 1, methodChain: ["status", "json"]` matches `res.status(X).json(Y)`.
- **`throwExpression`** — the node is a `ThrowStatement`, optionally requiring the thrown expression text to match a constructor pattern. For React Router: `constructorPattern: "httpErrorJson"` matches `throw httpErrorJson(...)`.

**Extraction:**

Given a matched terminal node, apply the `extraction` rules to pull out status code and body:

- `{ from: "property", name: "status" }` — read the `status` property from the object literal. If it's a numeric literal, produce `{ type: "literal", value: N }`. Otherwise `{ type: "dynamic", sourceText }`.
- `{ from: "argument", position: 0 }` — read the first argument of the matched call.
- `{ from: "constructor", codes }` — look the thrown expression's constructor name up in the pack-supplied `codes` map (full text first, then last dot-segment). Only fires for `throwExpression` matchers.

### Step 1b — `extractShape`: three-pass body-shape extraction

Response bodies and return values are extracted into `TypeShape` (see `ir-reference.md#typeshape`). The adapter runs three passes in order, stopping at the first that succeeds:

1. **Syntactic decomposition.** Object literals, array literals, and primitive literals decompose directly from the AST. This preserves *literal narrowness* that the type checker would widen: `return { status: "success" }` records `status` as `{ type: "literal", value: "success" }`, not `text`. Negative numerics (`-3`) and unary plus fold into the literal with signed `raw` text. Numeric literals carry `raw` so hex / scientific / separators / integers past `Number.MAX_SAFE_INTEGER` survive the IEEE 754 coercion.

2. **AST resolution.** For terminal nodes that aren't literals — bare identifiers, property access chains, destructuring bindings, local single-return function calls — the adapter walks back to the defining value and re-enters `extractShape` on that. This lets `const kind = "success"; return { kind }` still produce a literal shape even though the use-site type checker would have widened `kind` to `string`. The walker only recurses into initializers that are *syntactically informative* — literals, aggregate literals, ternaries, identifier / property chains. Call / await / `new` initializers skip this pass, because their declaration-site type is typically wider than use-site flow narrowing (e.g. `const user = await db.find()` returns `T | null`, but past a null guard the use site is just `T`).

3. **Type-checker fallback.** Anything the first two passes can't resolve is handed to ts-morph's type checker via `shapeFromNodeType`. This catches identifiers whose declarations live across module boundaries, generics, and types without literal initializers. The type checker sees flow narrowing at the reference site, so narrowed unions collapse correctly here. Opaque named types (`Date`, `Promise`, `Map`, `Error`, …) stop at `{ type: "ref", name: "Date" }` rather than expanding their structural properties, since the wire form is codec-dependent and the structural expansion would be misleading. Index-signature types (`Record<string, T>`, `{ [key: string]: T }`) with no named properties become `{ type: "dictionary", values: ... }`.

**Spreads.** `{ ...user, admin: true }` runs the spread expression through the same three-pass pipeline. A resolvable `record` result is merged in source order (later keys / later spreads override); only unresolvable spreads fall through to the `record.spreads[]` escape hatch. `union` spreads (e.g. a value narrowed to `record | null` where the caller would have flow-narrowed to `record`) — we currently treat these as unresolvable, matching the conservative "some extra fields could be anything" semantics.

**Recursion and cycles.** Both the type-checker walk and the AST walker bound recursion: the type walker caps at depth 6 and tracks already-expanded type identities; the AST walker caps at 8 hops and tracks node identities. Cyclic `const a = a` (and deeper variants) terminate at a `ref`.

## Step 2 — `collectAncestorBranches`

**Input:** a terminal AST node + the function root
**Output:** `AncestorBranch[]`, ordered outermost to innermost

Walk from the terminal upward to the function root. At each ancestor, check whether it's a branching construct; if so, record which branch the terminal is in.

```
collectAncestorBranches(terminal, functionRoot):
    branches = []
    current = terminal
    while current !== functionRoot:
        parent = current.getParent()
        if parent is null: break

        if parent is IfStatement:
            thenBlock = parent.getThenStatement()
            elseBlock = parent.getElseStatement()
            if current is inside thenBlock:
                branches.unshift({ kind: "if", branch: "then", condition: parent.getExpression() })
            else if elseBlock && current is inside elseBlock:
                branches.unshift({ kind: "if", branch: "else", condition: parent.getExpression() })

        else if parent is CaseClause:
            switchStmt = parent.getParent().getParent()
            if switchStmt is SwitchStatement:
                branches.unshift({
                    kind: "switch",
                    caseExpression: parent.getExpressions()[0],
                    switchExpression: switchStmt.getExpression(),
                })

        else if parent is CatchClause:
            branches.unshift({ kind: "catch", branch: "catch", condition: null })

        else if parent is ConditionalExpression:  // ternary
            if current === parent.getWhenTrue():
                branches.unshift({ kind: "ternary", branch: "then", condition: parent.getCondition() })
            else if current === parent.getWhenFalse():
                branches.unshift({ kind: "ternary", branch: "else", condition: parent.getCondition() })

        else if parent is BinaryExpression with operator "&&" or "||":
            // Left side is an implicit condition on the right side
            if current === parent.getRight():
                polarity = (operator === "&&") ? "positive" : "negative"
                branches.unshift({
                    kind: "logical",
                    branch: polarity === "positive" ? "then" : "else",
                    condition: parent.getLeft(),
                })

        current = parent

    return branches
```

**Edge cases to handle:**

- **`if` without `else`** — terminal in the then-branch gets one positive condition. Terminal *after* the if gets no ancestor condition here — it gets an early return condition via Step 3.
- **Switch fallthrough** — if a `case` has no `break`, the terminal could be reached from the previous case. For v0, record each case independently; fallthrough handling is a v1 concern.
- **`try`/`finally`** — a terminal in the `try` block executes unconditionally (no condition added). A terminal in `finally` executes always. A terminal in `catch` records `kind: "catch"` with a null condition (polarity is positive — the catch fired).
- **Optional chaining** (`a?.b.c`) — treat as an implicit nullish check: right side runs only if left is non-null.
- **Nested branches** — the algorithm walks all the way to the function root, so `if (a) { if (b) { terminal } }` produces two entries, outermost first.

**Why this is pure AST walk:** no symbol table access, no type checking, no framework patterns. This function takes two AST nodes and returns a list of nodes — nothing else. It can be tested with fixture functions that don't even need to compile, and its failure modes are easy to reason about.

## Step 3 — `collectEarlyReturns`

**Input:** a terminal AST node + the function root
**Output:** `EarlyReturn[]`

Find all `if (cond) return/throw` statements that appear *before* the terminal's containing statement. Each one contributes an implicit **negative** condition to the terminal — the terminal is only reached if the early return's condition was false.

```
collectEarlyReturns(terminal, functionRoot):
    terminalStatement = getContainingStatement(terminal)
    if terminalStatement is null: return []

    body = functionRoot.getBody()
    if body is null or not a Block: return []

    statements = body.getStatements()
    terminalIndex = statements.indexOf(terminalStatement)
    if terminalIndex === -1: return []  // terminal is nested, handled by ancestors

    earlyReturns = []
    for i from 0 to terminalIndex - 1:
        stmt = statements[i]
        if stmt is IfStatement:
            thenBlock = stmt.getThenStatement()
            if blockContainsReturnOrThrow(thenBlock):
                earlyReturns.push({
                    condition: stmt.getExpression(),
                    kind: blockContainsReturn(thenBlock) ? "return" : "throw",
                    polarity: "negative",
                })
    return earlyReturns
```

**Edge cases:**

- **Multiple guards** — `if (!id) throw; if (!user) throw; return user;` contributes two early return conditions (both negative) to the final return. Both conditions must be false for the terminal to be reached.
- **Nested early returns** — `if (a) { if (b) return; }` — for v0, treat the outer `if` as a single early return and record only `a`. The inner structure is a v1 refinement.
- **Early returns in else branches** — `if (a) { ... } else { return; }` is structurally just a control flow split, not an "early return" in the flat sibling sense. It's handled by `collectAncestorBranches` instead.
- **Returns inside blocks that are not if-statements** — e.g., `for (...) { if (cond) return; }` — for v0, these are ignored. The loop iteration semantics are too complex to capture correctly.

**Why this is separate from ancestor branches:** the two answer different questions. Ancestor branches ask "what conditions gate the branch I'm in?" Early returns ask "what conditions gated the flow *before* I got here?" Both apply to the same terminal simultaneously.

## Step 4a — `parseConditionExpression`

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

## Step 4b — `resolveSubject`

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

**Why the shape is shallow:** `resolveSubject` doesn't try to understand what `db.findById` does or what it returns. It just records "this value came from calling `db.findById`, and then we accessed `.repository.lastAnalyzedCommitHash`". That's enough for cross-boundary comparison to work — two predicates on different sides of a boundary can be recognized as testing the same thing — without the extractor needing to understand Prisma query semantics.

**Dependency on the compiler:** this is the most expensive step. Every identifier lookup goes through the symbol table. For a 500-line handler with 50 conditions, this can dominate extraction time. Two optimizations worth knowing about:

1. **Cache per-function** — within a single function, the same variable may be tested repeatedly. Cache `Identifier → ValueRef` lookups by node identity.
2. **Avoid project-wide reference search** — `findReferencesAsNodes()` walks the entire project and is quadratic in project size. Don't use it here; `getSymbol().getDeclarations()` is local and fast.

## Step 5 — Assembly

Compose the outputs of steps 1-4 into a list of `RawBranch`:

```
extractRawBranches(func, framework):
    terminals = findTerminals(func, framework.terminals)

    return terminals.map(terminal => {
        ancestors = collectAncestorBranches(terminal.node, func)
        earlyReturns = collectEarlyReturns(terminal.node, func)

        conditions = []

        // Early returns come first — they gate everything that follows
        for er in earlyReturns:
            pred = parseConditionExpression(er.condition)
            conditions.push({
                sourceText: er.condition.getText(),
                structured: pred,  // may be null → assembler wraps as opaque
                polarity: "negative",
                source: er.kind === "return" ? "earlyReturn" : "earlyThrow",
            })

        // Ancestor branches come after
        for branch in ancestors:
            if branch.condition is null:  // catch clause
                conditions.push({
                    sourceText: "<catch>",
                    structured: null,
                    polarity: "positive",
                    source: "catchBlock",
                })
            else:
                pred = parseConditionExpression(branch.condition)
                conditions.push({
                    sourceText: branch.condition.getText(),
                    structured: pred,
                    polarity: branch.branch === "then" ? "positive" : "negative",
                    source: "explicit",
                })

        return {
            conditions,
            terminal: terminal.data,
            effects: extractEffects(terminal.node, func),
            location: { start: terminal.node.getStartLineNumber(), end: terminal.node.getEndLineNumber() },
            isDefault: conditions.length === 0
                || conditions.every(c => c.source === "earlyReturn" || c.source === "earlyThrow"),
        }
    })
```

The `RawBranch[]` then flows to `assembleSummary()` in `@suss/extractor`, which handles the opaque-wrapping, gap detection, and confidence scoring. That logic is already implemented and tested — this document covers only the adapter side.

## Testing strategy

The five steps correspond to five independently testable units:

| File | Tests |
|------|-------|
| `terminals.test.ts` | Fixture handlers in ts-rest / Express / React Router styles; assert the expected terminal nodes are found with correct extracted data. |
| `branches.test.ts` | Fixture functions with `if`/`else`, `switch`, `try`/`catch`, ternary, `&&`/`||`. Assert the ancestor branch list for each terminal. |
| `earlyReturns.test.ts` | Fixture functions with sequential guard clauses. Assert each guard is detected with correct polarity. |
| `predicates.test.ts` | Individual expression nodes (not full functions). Assert the parsed `Predicate`. One test per AST expression kind. |
| `subjects.test.ts` | Fixture functions with parameter access, dependency call results, destructuring, property chains. Assert the resolved `ValueRef`. |

Each test uses its own small fixture — no end-to-end runs for unit tests. Full extraction integration tests live in three places: the adapter's own integration test (`packages/adapter/typescript/src/*.test.ts` against `fixtures/ts-rest`), each framework pack's integration test (adapter-against-fixtures for its own framework), and the CLI test suite (deep-equal assertions on representative summaries per framework, plus `-o` round-trip).

## Correctness principles

Three properties must hold for the algorithm to be trusted:

1. **Exhaustiveness** — every path through the function body maps to exactly one `RawBranch`. If not, the missing path becomes a gap, not a silent drop.
2. **No false conditions** — a predicate that appears on a transition must actually gate that transition in the source code. It's fine to under-specify (fall back to opaque); it's not fine to report a condition that isn't really there.
3. **Stable subjects across renames** — `ValueRef`s should be structurally equal across trivial renames. If a user renames `user` to `account`, the subject shape should still be `dependency("db.findById")` + property path — unchanged.

Violations of #1 degrade confidence but don't invalidate the summary. Violations of #2 or #3 are bugs and must be fixed.
