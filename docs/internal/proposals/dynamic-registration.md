# Dynamic registration — design proposal

A proposal for handling registration patterns that today's `registrationCall` discovery can't see: helper functions whose body registers N routes, loops over literal arrays of route specs, and config-driven app builders. These are the dominant shapes in production codebases — almost every non-trivial Express / Fastify / Hono backend has at least one — and their absence means suss reports zero routes for services that have many.

## Why this exists

`registrationCall` matches the literal `app.get('/users', handler)` shape. It misses:

- `registerCrud(app, 'users', handlers)` — helper that expands to N `app.X(...)` calls, with arguments substituted from the call site.
- `for (const r of routes) app[r.method](r.path, r.handler)` — loop over a literal array of route specs.
- `const app = buildApp({ routes: [...] })` — config-driven app builder where the route data lives in a config object.

Concretely, a team using a `registerCrud` helper for 12 resources today shows zero routes in suss. After this lands they show 48 (4 routes per resource × 12). When the frontend calls one of those routes and the path drifts, suss flags it; today it can't.

The same problem applies to NestJS modules, tRPC routers built from records, and Hono builder chaining — but those have their own discovery shapes (decorators, record literals) addressed by separate packs. This proposal is for the imperative-helper / loop / config-driven cases that share one underlying mechanism.

## Scope — v0

Two of the three sub-cases. The third (builder/router records) is its own pack family.

### 1. Registration helper templates

Pack authors declare templates that say "when you see this helper called with these arguments, generate these registrations":

```ts
{
  type: "registrationTemplate",
  helperName: "registerCrud",
  importModule: "./crud-helper",  // optional — narrows by source
  registrations: [
    { method: "GET",    pathTemplate: "/{0}",       handlerArg: "{1}.list" },
    { method: "POST",   pathTemplate: "/{0}",       handlerArg: "{1}.create" },
    { method: "PUT",    pathTemplate: "/{0}/:id",   handlerArg: "{1}.update" },
    { method: "DELETE", pathTemplate: "/{0}/:id",   handlerArg: "{1}.remove" },
  ],
}
```

`{0}`, `{1}` refer to positional arguments at the call site. The analyzer expands each template against the literal arguments, generating virtual `app.X(...)` units that feed into the existing `registrationCall` machinery.

When a positional argument isn't a literal (variable, computed expression), the template's path slot becomes opaque with a reason — the registration still emits, just with an unresolved path. The handler reference can also be opaque if the argument isn't a literal handler / object.

### 2. Loop over a literal array of route specs

```ts
const routes = [
  { method: 'get',  path: '/users', handler: getUsers },
  { method: 'post', path: '/users', handler: createUser },
];
for (const r of routes) app[r.method](r.path, r.handler);
```

Recognizing this pattern needs:

- The loop's iterable is a literal `ArrayLiteralExpression` (or a `const`-bound identifier resolving to one).
- The loop body is a single `app.X(...)` or `app[r.method](...)` call, with arguments drawn from the loop variable's properties.
- Each array element is an object literal whose properties match the recognizable shape (`method`, `path`, `handler` or some pack-declared mapping).

Each array element becomes a virtual registration. Non-literal elements (spread of an imported array, computed entries) are skipped with an opaque marker.

This is harder than templates because pattern-matching the loop shape is more invasive than matching a function call. v0 supports the dominant shape (the example above); other variants (`forEach`, `Object.entries(map).forEach`, conditionals inside the loop body) deferred.

## Out of scope, deferred

- **Builder / router records** (`t.router({ getUser: t.procedure.... })`, `oRPC.contract({ ... })`). These belong in per-library packs because the *value* itself is the registration, and the value's shape varies by library. The tRPC and ts-rest packs already handle some of this; expand individually as demand surfaces.
- **Decorator-based registration** (NestJS modules). Already partially handled by `decoratedRoute`. Out of scope here.
- **Auto-detected registration helpers.** Recognizing "this function is a route registration helper" without a pack-author declaration would need to look inside the helper body, recognize `app.X(...)` calls, and infer the substitution mapping. Tractable but expensive, and produces opaque results when the helper has any conditional logic. Defer to v1, behind a separate flag.
- **Loops over imported config** (`for (const r of importedRoutes)`). Needs cross-file literal evaluation. Defer.
- **Conditional registration** (`if (env === 'prod') app.get(...)`). Affects pair confidence; not just a registration question. Defer.
- **Computed paths beyond simple template strings**. `${prefix}/${resource}/:id` where both `prefix` and `resource` are literal substitutions is fine; arbitrary string concatenation isn't.

## Mechanics

### `registrationTemplate` discovery match

Add a new `DiscoveryMatch` variant in `@suss/extractor`:

```ts
{
  type: "registrationTemplate";
  helperName: string;
  importModule?: string;  // optional source-narrowing gate
  registrations: Array<{
    method: string;
    pathTemplate: string;       // {0}, {1}, ... refer to call args
    handlerArg: string;         // same substitution syntax
    statusCodes?: number[];     // optional, when the template implies
                                // specific responses (e.g. POST → 201)
  }>;
}
```

Discovery handler:

1. Find every `CallExpression` whose callee is an identifier matching `helperName`. If `importModule` is set, filter by the binding's import source.
2. For each match, extract the literal arguments at positions referenced by the templates (string literals → straight substitution; identifiers / property access → opaque marker with reason).
3. For each registration in the template, expand the path and handler reference using the call's arguments. Synthesize a virtual call expression (or a direct `DiscoveredUnit` with the resolved binding) and feed it into the same downstream pipeline as `registrationCall`.

The synthesized units carry a `derivedFrom` field pointing back to the helper call site, so inspect / coverage reports can trace why a registration exists when there's no literal `app.X(...)` to look at.

### `registrationLoop` discovery match (sub-case 2)

A separate variant for the loop pattern. More restrictive shape:

```ts
{
  type: "registrationLoop";
  framework: "express" | "fastify" | "hono" | ...;  // for callee shape
  // The loop's iterable must resolve to an array literal of object
  // literals with these keys (recognized in the loop body via property
  // access on the loop variable).
  elementShape: {
    methodKey: string;   // "method"
    pathKey: string;     // "path"
    handlerKey: string;  // "handler"
  };
}
```

The handler walks `ForOfStatement` / `ForStatement` nodes, validates the loop body matches the expected shape, and synthesizes registrations.

This is a heavier handler than the template variant. It's optional in v0 — packs can declare templates without loops, or both. The loop variant probably ships behind a flag initially until we see how often it's actually needed in practice.

## Confidence

Per-registration confidence:

- **High**: all template slots resolved to string literals, handler argument is a literal function or static reference.
- **Medium**: some slots opaque (variable / computed) but the path *shape* is recognizable. Path becomes `/{opaque}/things` or similar.
- **Low**: most slots opaque; the registration exists but neither path nor handler can be tied to anything specific.

Each derived registration also carries `confidence.source: "registration-template"` so downstream tooling can distinguish derived from literal `app.X(...)` registrations.

## Interactions with other packs

- **Conflict with `registrationCall`.** If a pack declares both `registrationCall` for `app.get(...)` AND `registrationTemplate` for a helper, and the helper is invoked, the helper's expanded registrations should NOT also trigger `registrationCall` (they're virtual, no literal call site). Templates emit their derived units directly into the discovery output, bypassing the source-walk that `registrationCall` does.
- **Cross-pack composition.** A user writing both an Express pack and a custom-helper pack (their own `registerCrud`) would have both active. The Express pack handles literal `app.get(...)` calls; the custom-helper pack handles `registerCrud(...)` expansions. Both feed registrations into the same downstream pipeline, no coordination needed.
- **Naming the `derivedFrom` link.** Inspect output for a derived registration should make it clear it came from a helper call, not a literal `app.X(...)`. The `derivedFrom` field carries the call site; inspect-rendering shows "derived from `registerCrud(app, 'users', userHandlers)` at `routes.ts:42`."

## Open questions

- **`handlerArg` syntax.** `{1}.list` substitutes argument 1 (an identifier or expression) and reads its `list` property. What about `{1}.list.bind(this)` or other transforms applied at the helper site? Probably out of v0 — keep the substitution syntax to literal property access, defer expression-level substitutions until a real codebase needs them.
- **Path-template precedence.** If the helper accepts a `prefix` parameter (`registerCrud(app, '/v1', 'users', handlers)` → `/v1/users`), the template would need `{0}{1}` or similar. Two-arg substitution is fine; arbitrary concatenation gets murky. Keep templates string-literal-only; multi-arg paths join with `/` if both are simple identifiers.
- **What about helper-of-helpers?** If `registerCrudV2` calls `registerCrud` internally, the template would need to expand transitively. v0 templates only fire on direct calls to the declared helper. A second pass that expands helpers found inside expanded calls is doable but introduces ordering problems; defer.
- **Inspect output shape.** Derived registrations should display alongside literal ones but be visually distinguishable. UX choice: show a `↳ derived from ...` line, or a separate section, or a confidence-level filter. Decide when implementing inspect changes.

## Validation

1. Unit tests for `registrationTemplate` discovery: literal-args case, opaque-arg case, multiple templates per helper, narrowed by `importModule`.
2. Integration test in `@suss/cli` against a synthetic Express service with a `registerCrud(app, 'users', userHandlers)` helper. Verify 4 routes appear in pairings.
3. Author a `@suss/framework-express-helpers` example pack with one or two common helper templates. Run dogfood-style test against an external Express codebase that uses the helpers and observe registration count delta.
4. Exercise the `registrationLoop` handler against the dominant shape (`for (const r of routes) app[r.method](...)`); verify expansion against literal arrays and opaque-marker emission against non-literal arrays.

## Cost estimate

- `registrationTemplate` discovery handler + IR plumbing: ~1 day. Mostly mirrors `registrationCall`; the substitution logic is the new piece.
- `registrationLoop` handler: ~1 day. Loop pattern matching is fiddlier; the validation step is bigger.
- Tests + integration test + dogfood validation: 1 day.
- Inspect rendering for `derivedFrom`: half a day, separable.

Total: 2.5–3.5 days for v0, depending on whether the loop variant ships in the same pass or follows. Smaller if we ship templates only and loop handler lands as a fast follow.

## Sequencing

If the runtime-node pack ships first (per the other proposal), this can land afterward without dependencies. Both are independent additions to the discovery surface.

The order I'd suggest, if both are on the table:

1. `runtime-node` first — lower risk, smaller surface, cleaner test story.
2. `registrationTemplate` next — bigger user-facing payoff (route counts on real backends), but needs careful template-author docs to avoid confusion about substitution syntax.
3. `registrationLoop` as a fast follow once templates are stable.

The decision point isn't technical — it's whether the immediate pain is "we miss scheduled callbacks" or "we miss helper-registered routes." For most teams running suss against backends, it's the latter. For dogfood, it's the former (suss itself uses neither pattern much).
