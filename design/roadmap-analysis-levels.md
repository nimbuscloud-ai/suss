# Analysis levels (L0 to L6)

This is an internal roadmap. The cross-boundary checker's comparisons build on each other in layers. The ladder below tracks how deep the comparison goes so far and what each level makes possible. The user-facing summary of what gets checked today is in [`cross-boundary-checking.md`](../docs/why/cross-boundary-checking.md). Levels 0 to 5 are implemented. Level 6 does not depend on the others and is in progress.

## Level 0: Status-code coverage (done)

The checker compares the sets of status codes. Does the consumer handle every status the provider produces? Does the provider produce every status the consumer expects?

This catches the most common integration failures: a new error status that no consumer handles, or a consumer branch for a status the provider stopped returning.

## Level 1: Sub-case detection (done)

When a provider has several transitions for the same status code (for example, two 200s gated by different conditions), the checker looks at whether the consumer tells them apart. If the consumer has a single 200 branch with no sub-case conditions, the checker emits a warning for each conditional provider transition.

This catches failures where "200 means success" is too coarse. The provider returns 200 in situations that mean different things, and the consumer treats them all the same.

## Level 2: Field-presence comparison (done)

For each consumer transition with `expectedInput`, the checker compares the fields the consumer reads with the provider's body shape for the matching status code. A missing field is a definite mismatch.

suss finds the fields a consumer reads by tracing property accesses on the response variable in each branch (for example `result.body.name` and `result.body.email`). Extraction collects them into a `TypeShape` on `Transition.expectedInput`, and they flow through `RawBranch` → `assembleSummary` → `Transition`.

## Level 3: Consumer vs declared contract (done)

The checker also compares the consumer's `expectedInput` with the body schema of the *declared* contract, on top of the provider's actual output. Say the consumer reads `body.role`, but the declared 200 schema only has `{ id, name, email }`. Then the consumer depends on an undeclared field. That field is an implementation detail, and the provider can remove it without breaking its contract.

We call this contract leakage: the consumer assumes more than the contract guarantees. The checker emits `consumerContractViolation` with `warning` severity, because nothing is broken today but the code is fragile.

## Level 4: Subject resolution through intermediates (done)

`resolveSubject` follows initializers that are not calls. For `const data = result.body` it recurses on the property access, and for `const alias = user` it recurses on the identifier. It stops after 8 hops. So when a consumer condition goes through intermediate variables, it keeps its chain back to the response variable.

## Level 5: Semantic condition bridging (north star)

Provider conditions and consumer conditions are often about the *same* thing, written in different places. The provider's condition `user.deletedAt` tests a database field, and the consumer's condition `result.body.status === "deleted"` tests a response field. They are correlated because the provider *puts* the data there and the consumer *reads* it.

The link between them is the **provider's output shape for each transition**:

1. Provider transition: when `user.deletedAt` is truthy, produce body `{ ...user, status: "deleted" }`
2. The body shape for that transition includes `status` with the literal value `"deleted"`
3. Consumer condition: `result.body.status === "deleted"`, a comparison predicate that tests a derived subject (response → body → status) against the literal `"deleted"`

So the checker can ask: **does the provider transition's output body contain a field whose value matches the consumer transition's comparison predicate?**

If the provider's body has `{ status: { type: "literal", value: "deleted" } }` and the consumer tests `body.status === "deleted"`, they match. The consumer is telling *this particular provider sub-case* apart from the others. If the consumer doesn't test for it, it is merging sub-cases. If the consumer tests for a value the provider never produces (for example `body.status === "suspended"` when no provider transition puts `"suspended"` in `status`), that branch is dead.

At this level suss catches the motivating example from end to end:

> A user endpoint starts returning `200` with `status: "deleted"` for soft-deleted accounts. Three services downstream break because they assumed `200` meant "the user exists and is usable."

At Level 5, suss reports: "Provider transition `getUser:response:200:a1b2c3d` produces body with `status: "deleted"` when `user.deletedAt` is truthy. Consumer `loadUser` handles status 200 but does not test `body.status`; this sub-case flows through without distinction."

Level 5 is implemented (`checkSemanticBridging`). It had the known limitations below, and each one is documented as an aspiration test in `semantic-bridging.aspirations.test.ts`:

1. ~~**Literal-only discrimination.**~~ **RESOLVED.** Field-presence discrimination now detects sibling transitions whose bodies have different structure (for example, one has `deletedAt` and the other doesn't), even when no literal values differ. A truthiness check in the consumer on the field that differs suppresses the finding. When both kinds of discrimination are available, literal discrimination wins.

2. ~~**Negated comparisons.**~~ **RESOLVED.** The checker now treats `!== "active"` as covering any sub-case whose value isn't `"active"` (for example `"deleted"`). It handles both `comparison(neq)` and `negation(comparison(eq))`, and it cancels double negation.

3. ~~**Hardcoded `"body"` property accessor.**~~ **RESOLVED.** The checker now recognizes `res.json()` as a body accessor, and treats properties read from the result of a `.json()` call as paths relative to the body. Other body accessor patterns, such as custom deserializers or `.text()` + `JSON.parse`, are still not supported.

4. ~~**Provider body shapes must be structurally visible.**~~ **RECLASSIFIED.** The extractor's three-pass strategy already handles the common cases. Named interfaces expand to records (not refs), and `resolveCall` inlines local functions with a single return, which keeps the literals narrow. Ref shapes only appear for functions with several returns, method calls, and functions in other modules whose body the extractor can't see. Those belong to Level 6 (local function inlining).

5. ~~**`as const` dependency for narrow literals.**~~ **RECLASSIFIED.** The extractor's syntactic pass (Pass 1) DOES keep literals without `as const` for direct object literals, variable bindings, and local functions with a single return. The type-checker fallback (Pass 3) only takes over when the body goes through code the AST resolver can't trace, which is the same Level 6 gap as aspiration 4. Extractor tests in `shapes.test.ts` verify this.

6. ~~**Truthiness checks invisible.**~~ **RESOLVED.** Extraction now picks up `truthinessCheck` predicates on body fields as consumer field tests. A truthiness check on a path matches any literal that tells sub-cases apart at that path, because the consumer IS making a distinction on that field. One gap remains, which is reasoning about the complement. Nothing works out by itself that the negated or default case covers the opposite sub-case.

## Level 6: Local function inlining (independent)

When a provider condition is a call to a local helper (`if (!isActive(user))`, where `isActive` is `(u) => !u.deletedAt && !u.suspendedAt`), the extractor records the condition as an opaque `call` predicate today. Inlining the helper's body would produce two structured truthiness-check predicates instead.

Whether to inline comes down to one question: **can we resolve the function body statically to a single expression with no side effects?** If yes, inline it. If no, leave it opaque. Inlining improves confidence scores and makes Levels 1 to 5 more effective, but it does not depend on them.
