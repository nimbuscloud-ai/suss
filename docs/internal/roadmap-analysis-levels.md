# Analysis levels (L0 to L6)

Internal roadmap. The cross-boundary checker's comparisons compose in layers, each one building on the previous. The ladder below tracks how deep the comparison goes so far and what each level unlocks. The user-facing summary of what's checked today is in [`cross-boundary-checking.md`](../cross-boundary-checking.md). Levels 0 to 5 are implemented, and Level 6 is independent and in progress.

## Level 0: Status-code coverage (done)

Set comparison on status codes. Does the consumer handle every status the provider produces? Does the provider produce every status the consumer expects?

This catches the most common integration failures: a new error status that no consumer handles, or a consumer branch for a status the provider stopped returning.

## Level 1: Sub-case detection (done)

When a provider has multiple transitions for the same status code (e.g., two 200s gated by different conditions), check whether the consumer distinguishes between them. If the consumer has a single 200 branch with no sub-case conditions, emit a warning per conditional provider transition.

This catches the class of failure where "200 means success" is too coarse: the provider returns 200 in semantically different situations that the consumer collapses.

## Level 2: Field-presence comparison (done)

For each consumer transition with `expectedInput`, compare the set of fields the consumer reads against the provider's body shape for the matching status code. A missing field is a definite mismatch.

suss tracks the consumer's fields by tracing property accesses on the response variable within each branch (e.g., `result.body.name`, `result.body.email`). Extraction collects these into a `TypeShape` on `Transition.expectedInput`, and they flow through `RawBranch` → `assembleSummary` → `Transition`.

## Level 3: Consumer vs declared contract (done)

Compare the consumer's `expectedInput` against the *declared* contract's body schema, not the provider's actual output alone. If the consumer reads `body.role` but the declared 200 schema only has `{ id, name, email }`, the consumer depends on an undeclared field, an implementation detail that the provider can remove without violating its contract.

This is the "contract leakage" check: the consumer assumes more than the contract guarantees. It emits `consumerContractViolation` with `warning` severity, because this is not a bug today but it is fragile.

## Level 4: Subject resolution through intermediates (done)

`resolveSubject` follows non-call initializers (`const data = result.body` → recurse on the property access, `const alias = user` → recurse on the identifier). It is bounded at 8 hops. So a consumer condition that goes through intermediate variables keeps its chain back to the response variable.

## Level 5: Semantic condition bridging (north star)

The core insight: provider conditions and consumer conditions are about the *same semantic concept* but expressed in different domains. The provider's condition `user.deletedAt` (a database field) and the consumer's condition `result.body.status === "deleted"` (a response field) are correlated: the provider *puts* the data there, the consumer *reads* it.

The bridge between them is the **provider's output shape per transition**:

1. Provider transition: when `user.deletedAt` is truthy, produce body `{ ...user, status: "deleted" }`
2. The body shape for that transition includes `status` with value `"deleted"` (a literal)
3. Consumer condition: `result.body.status === "deleted"`, a comparison predicate testing a derived subject (response → body → status) against literal `"deleted"`

The checker can ask: **does the provider transition's output body contain a field whose value matches the consumer transition's comparison predicate?**

If the provider's body has `{ status: { type: "literal", value: "deleted" } }` and the consumer tests `body.status === "deleted"`, that's a semantic match: the consumer is distinguishing *this specific provider sub-case*. If the consumer doesn't test for it, it's collapsing sub-cases. If the consumer tests for a value the provider never produces (e.g., `body.status === "suspended"` but no provider transition puts `"suspended"` in `status`), that's a dead branch.

This is the level at which suss catches the motivating example end-to-end:

> A user endpoint starts returning `200` with `status: "deleted"` for soft-deleted accounts. Three services downstream break because they assumed `200` meant "the user exists and is usable."

At Level 5, suss reports: "Provider transition `getUser:response:200:a1b2c3d` produces body with `status: "deleted"` when `user.deletedAt` is truthy. Consumer `loadUser` handles status 200 but does not test `body.status`; this sub-case flows through without distinction."

Level 5 is implemented (`checkSemanticBridging`) with the following known limitations, each documented as an aspiration test in `semantic-bridging.aspirations.test.ts`:

1. ~~**Literal-only discrimination.**~~ **RESOLVED.** Field-presence discrimination now detects when sibling transitions have structurally different bodies (e.g., one has `deletedAt`, the other doesn't) even without literal value differences. A consumer truthiness check on the distinguishing field suppresses the finding. Literal discrimination takes priority when both are available.

2. ~~**Negated comparisons.**~~ **RESOLVED.** The checker now recognizes `!== "active"` as covering any sub-case whose value isn't `"active"` (e.g., `"deleted"`). It handles both `comparison(neq)` and `negation(comparison(eq))`, and it cancels double negation.

3. ~~**Hardcoded `"body"` property accessor.**~~ **RESOLVED.** The checker now recognizes `res.json()` as a body accessor: it treats properties accessed on a `.json()` call result as body-relative paths. Someone would still have to add the other body accessor patterns (custom deserializers, `.text()` + `JSON.parse`).

4. ~~**Provider body shapes must be structurally visible.**~~ **RECLASSIFIED.** The extractor's three-pass strategy already handles the common cases: named interfaces expand to records (not refs), and `resolveCall` inlines single-return local functions, which keeps the literals narrow. Ref shapes only appear for multi-return functions, method calls, and cross-module functions with no visible body. Those belong to Level 6 (local function inlining).

5. ~~**`as const` dependency for narrow literals.**~~ **RECLASSIFIED.** The extractor's syntactic pass (Pass 1) DOES preserve literals without `as const` for direct object literals, variable bindings, and single-return local functions. The type-checker fallback (Pass 3) only overrides when the body goes through a code path the AST resolver can't trace, which is the same Level 6 gap as aspiration 4. Extractor-level tests in `shapes.test.ts` verify this.

6. ~~**Truthiness checks invisible.**~~ **RESOLVED.** Extraction now picks up `truthinessCheck` predicates on body fields as consumer field tests. A truthiness check on a path matches any distinguishing literal at that path, because the consumer IS making a distinction on that field. One gap remains: complement reasoning. Nothing works out on its own that the negated or default case covers the opposite sub-case.

## Level 6: Local function inlining (independent)

When a provider condition is a call to a local helper (`if (!isActive(user))` where `isActive` is `(u) => !u.deletedAt && !u.suspendedAt`), the current extractor records the condition as an opaque `call` predicate. Inlining the helper body would produce two structured truthiness-check predicates instead.

The question that decides it: **can we statically resolve the function body to a single expression with no side effects?** If yes, inline. If no, stay opaque. This improves confidence scores and makes Levels 1-5 more effective, but it is independent of them.
