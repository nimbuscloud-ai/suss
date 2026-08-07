# Adapter owns the ECMAScript spec: design proposal

Two related changes to the TypeScript adapter so it understands language-level scope and Promise value flow without each runtime pack having to redeclare them. Closes the recognizer scope-isolation gap and unlocks consumer-side multi-hop binding through `.then` chains. Runtime packs stop being responsible for body-walking around plain scope-creating expressions; that becomes automatic in the adapter.

## Why this exists

Today, recognizers walk the body of a unit but stop at every nested function expression. So a handler like:

```ts
app.get("/users/:id", (req, res) => {
  fetch(internalUrl).then(r => r.json()).then(data => res.json(data));
});
```

has the `fetch` recognizer not firing on the call inside the `.then` callback. Each runtime pack that wants to see inside nested callbacks has to declare its own body-walking. `runtime-node`'s `nodeSchedulingSubUnits` exists for this reason: so that the body of `setTimeout(() => ...)` becomes walkable.

Two costs:

1. Every runtime pack reinvents the same descent logic. Adding Bun, Deno, Cloudflare Workers, or a browser runtime means redeclaring the same language primitives (`setTimeout`, `setInterval`, `Promise.then`, and so on) when none of them are runtime behaviors. They're ECMAScript.
2. Promise chains are unbound. Even after walking inside `.then(cb)`, the analyzer doesn't know that `cb`'s parameter is the resolved value of the upstream expression. So `fetch(url).then(r => r.json()).then(data => use(data))` leaves `data` opaque, and consumer packs (e.g. `client-web` reasoning about `.json()` shapes) can't pair the parsed body against a contract.

Both fall on the adapter, not on packs, because both are language-level. ECMAScript defines what a nested function expression is and what `Promise.then` resolves to. Runtime packs should only own runtime-specific behavior: timer semantics, the `process` surface, module loading.

Flagged when dogfooding `runtime-node` against Twenty (the recognizer scope-isolation gap surfaced there), and again when drafting `docs/tutorial/pair-frontend-backend.md`: the `.then(res => res.json()).then(data => setName(data.name))` chain produced no findings against the OpenAPI contract.

## Scope (v0)

Two areas, both inside the adapter.

### 1. Recognizers walk into nested function bodies

Any `FunctionExpression` or `ArrowFunctionExpression` nested inside a unit body is descended into by the unit walker. Recognizers fire there as if the code were inline.

Today's walker treats every nested function as a hard stop. After the change, the walker descends through them unless the function has been declared as a sub-unit boundary by a pack. Sub-unit declarations remain the only opt-out.

This covers, for example:

- Promise executors (`new Promise((resolve, reject) => { ... })`)
- `.then` / `.catch` / `.finally` callbacks
- Array iteration callbacks (e.g. `forEach` and `map`)
- IIFEs

Distinction from sub-units: a sub-unit is a *unit of record*; it pairs against contracts, has its own boundary identity, shows up in `inspect` as a separate row. A nested function the walker descends into is scope. Any effect emitted inside attaches to the parent unit's transitions.

Sub-units stay explicit. `framework-react`'s `useEffect` callbacks remain sub-units (units of record for the React lifecycle). `framework-express`'s registered handlers remain sub-units. `runtime-node`'s scheduling callbacks remain sub-units (separate execution context); the body-walking that today lives in `nodeSchedulingSubUnits` moves out, but the sub-unit declaration stays.

### 2. Promise `.then` parameter binds to the upstream value

When the adapter sees `expr.then(cb)` where `cb` is a function expression, the first parameter of `cb` binds to the resolved value of `expr`.

The TypeScript checker already knows the resolved type: `Promise<Response>` for `fetch(url)`, `Promise<unknown>` for generic Promise. The new piece is a symbol-table annotation: the parameter symbol carries `derivedFrom: { kind: "promise.then", upstream: SymbolRef }`. Recognizers that resolve a parameter's value follow this link and find the upstream expression's value.

`.catch(cb)` binds the parameter to the rejected value (typically opaque). `.finally(cb)` has no parameter binding.

This unlocks the consumer multi-hop:

```ts
fetch("/users/" + id)
  .then(res => res.json())   // res = Response (upstream: fetch)
  .then(data => use(data));  // data = parsed JSON (upstream: res.json())
```

After this lands, `client-web`'s existing `responseSemantics` for `.json()` flows end-to-end: the parsed body's shape reaches `use(data)`, where field-level checking can compare it against the contract.

## Out of scope, deferred

- **`await` chain binding.** `const r = await p` already binds `r` correctly via the TypeScript checker, and the adapter inherits that. No new work; confirm during validation.
- **Generator / async-iterator value flow.** `yield` chaining and `for await (const x of asyncIter)` aren't common in the codebases we care about. Defer.
- **`Function.prototype.call` / `apply` / `bind` thisArg.** Different problem; doesn't intersect.
- **Thenable narrowing.** A `.then` call on something with a `then` method that isn't a Promise (custom builder pattern, jQuery Deferred, etc.) gets the same binding treatment. Could narrow to `Promise<T>` proper later if false-positive bindings show up.
- **Cross-file Promise value flow.** Works for free because the TypeScript checker resolves return types cross-file; if the upstream is opaque, the binding is opaque. Not a separate work item.

## Mechanics

### Walker change

Today's walker (around `packages/adapter/typescript/src/walkers/`) treats every `FunctionExpression` and `ArrowFunctionExpression` as a hard stop. The change: descend through them by default. A pack-declared sub-unit boundary is the only reason to stop.

The mechanism is structural. There's no opt-in for packs to declare "yes I want my recognizer to fire inside callbacks": every recognizer fires everywhere by default. The opt-out is sub-unit declaration: if a pack declares a callback as a sub-unit, recognizers fire there but with the sub-unit's identity, not the parent's.

### Promise binding

Two pieces:

1. **Detection.** When traversing a `CallExpression`, check whether the callee is a `PropertyAccessExpression` named `then` / `catch` / `finally` and whose receiver has a Promise type per the TypeScript checker.
2. **Binding.** If the first argument is a function expression, walk its parameter list and annotate the first parameter's symbol with `derivedFrom`. The symbol-table extension adds one new field to symbol metadata.

The existing parameter-value resolver follows `derivedFrom` when present, treating the parameter as a stand-in for the upstream expression's value.

### `runtime-node` migration

`nodeSchedulingSubUnits` (in `packages/runtime/node/src/scheduling.ts`) loses its body-walking responsibility. The pack continues to declare which callbacks are sub-units (scheduling callbacks remain units of record); the walker handles descent.

Concretely: the declaration shape stays. The body-walking helper that the pack invokes internally is deleted. The adapter is already walking.

## Confidence

- **Walker descent** has no confidence axis. It's structural: recognizers fire or don't based on syntactic presence.
- **Promise binding** inherits confidence from the upstream expression. `Promise.resolve(literal).then(cb)` resolves to the literal (high). `fetch(url).then(r => r.json())` resolves `r` to `Response` (high; the TypeScript checker knows). `someOpaqueFn().then(cb)` resolves to opaque (low).

Recognizers already handle opacity; the new annotation either gives them a resolved upstream value or it doesn't, and they degrade as they would for any other unresolved expression.

## Interactions with other packs

- **`framework-react` `useEffect`.** Already a declared sub-unit. Stays a sub-unit; the walker descends as usual but the sub-unit identity preserves React-lifecycle semantics.
- **`framework-express` registered handlers.** Already sub-units. Same treatment.
- **`runtime-node` scheduling.** Per the migration above: callbacks remain sub-units; body-walking moves out.
- **`client-web` `.then(res => res.json())` chain.** Currently emits `responseSemantics` for the `.json()` call. After this lands, the parsed body's shape flows downstream and field-level checks fire against the contract.
- **Future runtime packs (Bun, Deno, Workers, browser).** Each can declare its own runtime-specific primitives without redeclaring walking or Promise binding. Lowers the cost of a new runtime substantially.

## Open questions

- **`forEach` / `map` element binding.** Walker descent into `arr.forEach(x => ...)` is in scope; this proposal does not commit to binding `x` to an element of `arr`. That's a separate annotation similar to Promise binding (`derivedFrom: { kind: "array.element", upstream: arr }`) and a separate work item.
- **What counts as Promise-like for binding?** TypeScript distinguishes `Promise<T>` proper from `PromiseLike`. Default: bind only on `Promise<T>`. Permissive variant binds on any `.then` with a function argument. Start strict; loosen if production codebases show useful cases that the strict check misses.
- **Method-chain after `await`.** `await fetch(url).then(r => r.json())`: the binding applies to the inner `.then`, `await` applies to the chain. Should work without special handling; fixture it.
- **Performance.** Walking through every nested function on every unit body multiplies traversal cost. The TypeScript checker already does similar work for type inference, so the cost is linear in code size. Validate during dogfood.

## Validation

1. Adapter unit tests:
   - Recognizer fires inside `new Promise((r, j) => {...})`
   - Recognizer fires inside `.then(cb)` callback
   - Recognizer fires inside `forEach(x => ...)`
   - Promise parameter binding for `fetch(url).then(r => r.json()).then(data => ...)`
2. `runtime-node` migration test: existing `setTimeout` / `setImmediate` fixtures pass with the body-walking deleted from the pack.
3. Re-extract Twenty; confirm scheduled paths that previously dropped now appear in coverage.
4. Re-run the pair-frontend-backend tutorial end-to-end (`docs/tutorial/pair-frontend-backend.md`). The expected findings (`unhandledProviderCase` for 404, `consumerFieldMismatch` for `.name` vs `.fullName`) should fire. If they do, the tutorial unblocks.

## Doc impact

- `docs/architecture.md`: the "Adapter vs pack ownership" section already states the principle; add a sentence noting walker descent and Promise binding as the concrete examples.
- `docs/packs.md`: cross-reference in the "what belongs in a pack" section.
- `docs/guides/writing-a-pack.md`: the runtime-node anatomy needs an update noting that body-walking is no longer the pack's concern.
- `docs/internal/proposals/runtime-node.md`: addendum noting that body-walking moved to the adapter.

## Cost estimate

- Walker change + tests: ~1 day. The walker exists; this changes its descent behavior.
- Promise binding (detection + symbol annotation + resolver follow): ~1 day. The symbol table is the unfamiliar piece.
- `runtime-node` migration + test fixup: half a day. Mostly deletion.
- Integration tests + dogfood re-run + tutorial re-test: 1 day.
- Doc updates: half a day.

Total: ~4 days, single pass.

## Sequencing

- Ships before re-testing the pair-frontend-backend tutorial. The tutorial depends on the `.then` chain producing field-level findings.
- Independent of #45 (the env-var recognizer merge into `runtime-node`, since landed) and #47 (`excludeCallReturns` fix); ships in any order.
- Independent of #48 (URL inputs for contract reader).
- Connects to the broader project direction: the PRD / intent generative-doc arc depends on field-level findings being trustworthy on consumer code, which this change enables.

## Decision log (as shipped)

Walker descent shipped complete, including class-method bodies. Promise `.then` binding shipped at the parameter-value resolver. The consumer field-access flow that unblocks the tutorial end-to-end is the explicit remainder.

Structural knowledge landed in the adapter (`packages/adapter/typescript/src/walk/descent.ts`); no runtime or framework pack gained language-specific logic.

- **D1: descent scope is function expressions and arrows only.** The body walkers descend through nested `FunctionExpression` / `ArrowFunction` (Promise executors, `.then` / `.catch` / `.finally` callbacks, `forEach` / `map` bodies, IIFEs). Nested `FunctionDeclaration` / `MethodDeclaration` remain hard stops: they are named units of record reached through discovery or the reachable-closure pass, and descending into them would double-attribute their behavior. This matches the proposal's wording ("Any `FunctionExpression` or `ArrowFunctionExpression`").

- **D2: sub-unit boundaries are the only opt-out, computed from the discovering pack.** A single helper `isDescentStop(node, func, barriers)` encodes the rule; `barriers` is the set of nested functions the discovering pack's `subUnits` hook claims. Barriers are computed in `extractFromSourceFile` by invoking the same hook `synthesizeSubUnits` runs later, so the barrier set matches exactly the functions that become sub-units. Without this, descent would attribute a React handler's or `useEffect` body's calls to the component *and* to the handler/effect summary. Packs are unchanged: the adapter reads their existing `subUnits` declaration.

- **D3: terminal descent is gated to escaping outputs.** The proposal frames descent around recognizers and effects (position-independent behavior). Terminal discovery also descends, but only terminal kinds whose observable output flows through a channel the unit owns are matched inside a nested function; today that is `parameterMethodCall` (a `res.json(...)` on the unit's own `res` parameter). Value-returning terminals (`return`, returned object shape, JSX render) stay scoped to their nearest enclosing function, because a `return` inside a `.then` callback yields the callback's value, not the unit's. `throwExpression` / `functionCall` are conservatively left scoped (an async callback's throw does not escape to the unit); revisit if a concrete case needs them.

- **D4: class-method bodies descend exactly like function bodies.** `func` (the unit root) is never a descent stop, whether it is a `FunctionDeclaration`, arrow, or `MethodDeclaration`. A class method that is the discovered unit has its body walked, and a nested arrow inside it (e.g. a `.then` callback producing `res.json(...)`) is descended and its terminal found. Regression fixture (c) covers this.

- **D5: Promise binding is strict (open question resolved).** Binding fires only when the `.then` / `.catch` receiver is `Promise`-typed per the TypeScript checker (`receiverIsPromiseTyped`). A custom thenable (a builder with a `then` method that is not a `Promise<T>`) declines and the parameter resolves as an ordinary input. This is the proposal's "start strict" default; loosen to the permissive variant only if production codebases show useful cases the strict check misses.

- **D6: Promise binding started inline in the parameter-value resolver; the shared `derivedFrom` link is now materialized.** The proposal described a `derivedFrom: { kind: "promise.then", upstream }` annotation that "the existing parameter-value resolver follows." The first cut computed the upstream on demand inside `resolveSubject` (`resolveThenParameter` → `resolvePromiseValue`). Once a *second* consumer needed the same fact (see D8), the structural half of that computation moved to a shared helper, `thenParameterLink` in `packages/adapter/typescript/src/promiseThen.ts`, which returns the link `{ kind: "promise.then", method, upstream }` for a `.then` / `.catch` callback parameter. Both consumers read it; the condition resolver's observable behavior is unchanged (`fetch(url).then(res => { if (!res.ok) ... })` still resolves `res` to the result of `fetch`, and `.then(res => res.json()).then(data => use(data))` resolves `data` to the result of `res.json()`).

- **D7: `await` chains inherit binding for free (confirmed).** `const r = await p` already resolves through the checker; `resolveSubject` strips `await`. No new work, as the proposal predicted.

- **D8: the `derivedFrom` link now has two consumers.** The field-access collector `collectClientFieldAccesses` (`packages/adapter/typescript/src/shapes/fieldAccesses.ts`) follows the same `thenParameterLink` the condition resolver uses. When the response never binds to a variable, `buildThenChainAccessor` resolves every `.then` callback parameter inside the unit to the property chain (rooted at the response call) its value stands for: `res → []`, `res.json()` flowing into the next callback's `data → ["json"]`. A read like `data.name` becomes `["json", "name"]`, nested under the `json` body accessor the checker already strips. This handles both the outer chain (`.then(res=>res.json()).then(data=>...)`) and inner chains rooted at a bound parameter (`res.json().then(data=>...)`) uniformly, because each parameter resolves back through its own link to the response call. Binding stays strict (D5): the `Promise`-typed gate is shared, so a custom thenable declines on both consumers. The two structural helpers `thenParameterLink` and `callbackReturnExpression`, plus the `Promise`-typed gate, live in `promiseThen.ts` so neither consumer re-derives them.

### Remainder (not shipped)

- **Terminal synthesis for void `.then` callbacks.** The tutorial's inline `useEffect(() => { fetch(...).then(...).then((data) => setName(data.name)) })` form produces no consumer transition: the callback returns nothing, so the client unit (the enclosing arrow) has no terminal, and there is nowhere to attach the field access. A data-loader that *returns* the chain (`return fetch(...).then(...).then((data) => data.name)`) does carry a default transition, so the field-flow surfaces end-to-end there, covered by `packages/cli/src/pairFrontendBackendIntegration.test.ts`, which fires `unhandledProviderCase` for the 404 and the 200-body field mismatch, plus the OpenAPI-contract `consumerContractViolation` equivalents. Synthesizing a default transition for a terminal-less consumer function is a separate gap, orthogonal to the field flow this change delivers.

- **runtime-node body-walking migration.** `nodeSchedulingSubUnits` is retained unchanged. With adapter descent, behavior inside a scheduling callback becomes visible by attaching to the enclosing unit, which closes the "invisible behavior" gap for the common case (a `setTimeout` callback inside an Express handler: express declares no `subUnits`, so the callback is not a barrier and its calls attach to the handler). Deleting the pack's body-walking as the proposal's migration describes is entangled with cross-pack sub-unit synthesis (running every pack's `subUnits` on every parent, so a scheduling callback inside an Express handler becomes its own sub-unit), which does not exist today and is out of scope here. Deferred to keep the runtime-node pack stable.

- **`forEach` / `map` element binding** stays out of scope, as the proposal states.
