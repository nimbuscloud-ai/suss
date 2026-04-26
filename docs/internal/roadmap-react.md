# React roadmap

Strategic plan for React as suss's first non-HTTP boundary. Captures direction so context survives compaction and implementation stays on-thesis. Phases shipped are marked ✅; everything else is design until the preceding phase has answered its forcing-function questions.

Related: [`boundary-semantics.md`](boundary-semantics.md) (transport / semantics / recognition layering), [`contracts.md`](contracts.md) (the five-shape contract taxonomy).

## Where this fits in the bigger picture

Suss today ships one concrete boundary kind: HTTP. The IR is protocol-agnostic in its type shapes, but the checker, pairing, and packs all converged on HTTP. The "behavioral understanding platform" positioning is credible only insofar as we can prove the abstraction works for a second boundary kind.

React is the first forcing function we're implementing. Why React rather than GraphQL (same transport, different semantics), RDS/Postgres (different substrate entirely, biggest latent value), or Vue (simpler technical case):

- **Adoption reach.** React has the largest developer base of the realistic targets.
- **Hardest declaration density.** React formalizes the least of any mainstream component framework. No `defineEmits`, no `defineSlots` — callbacks are arbitrary props, children are ad hoc. If the IR survives React, it survives easier cases by induction.
- **Forces the `BoundarySemantics` refactor.** React's boundary (component ↔ DOM) shares no structure with HTTP's (client ↔ server). Pairing by `(method, path)` doesn't apply; status codes don't apply. The checker can't fake REST-shape and has to generalize.

## React components are N code units, not one

This is the key framing decision and worth stating plainly before the phases.

A React component as a source-file concept is *not* one behavioral unit. It's a cluster:

- The **render body** runs on every render — inputs are props/state/context, output is a JSX tree, effects are reads of state and invocations of child components.
- Each **event handler** is its own entry point — inputs are synthetic event + closed-over state/props, outputs are state mutations and callback-prop invocations.
- Each **`useEffect` body** is its own unit — inputs are the dependency array's values, outputs are side-effects (subscriptions, network calls, DOM writes), with a cleanup sub-unit.
- Each **`useMemo` / `useCallback` body** is the same shape as a render-fragment, keyed on deps.

These share identity (same component module + export) and share state (hooks/closures), but they have distinct inputs, distinct outputs, and fire at distinct times. Treating them as one "lifecycle summary" would conflate semantically different events and lose the information that makes React findings useful.

This reuses the HTTP abstraction without new concepts. A single Express handler file can register `app.get("/users", h1)` and `app.post("/users", h2)` — two code units sharing a module. Similarly, a React component file exports one default component whose render + handlers + effects are multiple code units sharing an identity prefix. The `BoundaryBinding.semantics` layer distinguishes them (`render` vs `event-handler(name="onClick")` vs `effect(index=0)`).

This is also where the **theoretical grounding** comes in. In Daniel Jackson's concept-design framework (MIT — see [*The Essence of Software*](https://essenceofsoftware.com/), [*Concept Design Moves*](https://people.csail.mit.edu/dnj/publications/nfm-design-moves-22.pdf), [*What You See Is What It Does*](https://arxiv.org/abs/2508.14511)), a concept is a self-contained unit with state + actions + purpose, and synchronizations are rules of the form "when action A₁ in concept C₁ happens, action A₂ in concept C₂ happens." Under that framing:

- A suss code unit ≈ a concept's action (one triggerable behavior)
- Shared closure/hook state ≈ the concept's state
- `setState` → re-render is a synchronization: "when `onClick.setState(n)` fires, `render` observes n and produces new JSX"
- The cluster of units sharing a React component identity ≈ one concept instance

We don't adopt Jackson's vocabulary wholesale — "purpose" requires intent declarations suss doesn't have — but the structural mapping is close enough that the N-units-per-component decision is theoretically justified, not just pragmatic.

Two deliberate divergences from Jackson worth stating:

1. **Intent is absent.** Jackson concepts declare purpose top-down; suss infers behavior bottom-up. The closest proxy is `contractDisagreement` findings — they fire when observed behavior contradicts declared contracts, which is the closest suss gets to "purpose violated."
2. **Genericity is absent.** Jackson concepts are reusable design primitives (like `Upvote`, `Follow`). Suss summaries are instance-specific. The recursive-opaqueness-reduction goal leaves open a path where recurring clusters surface as concept candidates, but that's future work, not v0.

Further reading: Daniel Jackson, [*Concept Design Moves*](https://people.csail.mit.edu/dnj/publications/nfm-design-moves-22.pdf) (NFM 2022); Eagon Meng & Daniel Jackson, [*What You See Is What It Does*](https://arxiv.org/abs/2508.14511) (SPLASH Onward! 2025); Jackson, [*The Essence of Software*](https://essenceofsoftware.com/) (Princeton, 2021). Long-form mapping — audience indexing, failure modes, PRDs-as-concept-declarations — in [`concept-design.md`](concept-design.md).

## The boundary React actually has

Every React component source file looks like a function that takes props and returns JSX. But where's the *boundary* — the point where behavior becomes observable?

Not between parent and child component. They're both providers composing into the same output.

Not between component and React runtime — that's a platform relationship (like handler ↔ Express), not a contract between two peers.

The boundary is **component source ↔ DOM / user**. The DOM is where component behavior becomes observable. Snapshots, Playwright specs, visual regression baselines, screen-reader behavior — every existing contract shape for React describes behavior at the DOM boundary, not at the component interface.

This maps directly to the HTTP case:

| HTTP | React |
|---|---|
| Handler source | Component code units (render, handlers, effects) |
| HTTP message on the wire | Rendered DOM tree + dispatched events |
| Client code | DOM (observed by tests, users, screen readers, visual-regression) |
| OpenAPI describes the wire | Storybook / snapshots / Playwright describe the DOM |

So a React boundary in suss is `(module, component-name, unit-kind)`; the pairing key is the component identity plus the unit kind; the "consumer" side is expressed through whatever stub shapes someone authored (primarily Storybook at first).

## Contract shapes in React are plural and partial

This is the sharpest departure from HTTP. For an HTTP endpoint, one canonical contract shape (OpenAPI or its framework-specific equivalent) tends to carry the whole declared contract. For React, *no single shape captures a full component contract*:

| Shape | Captures | Coverage | Epistemic character |
|---|---|---|---|
| TypeScript props interface | Input type surface | Full (for types) | Signature — necessary, not sufficient |
| Storybook stories | Named canonical scenarios + `args` + optional `play` | Curated set | Partial **specification** |
| Snapshots (Jest / Vitest) | Rendered tree for specific tests | Tested instances | Partial **observation** |
| Playwright / RTL | Event → effect sequences | Tested interactions | Behavioral **observation** |
| Figma / design tokens | Visual intent | Designer's scenarios | Design-source-of-truth (see punt below) |
| Inferred summary (from code) | All branching paths, state reads, effects | Full (for code behavior) | Structural **derivation** |

Three distinct kinds of epistemic contribution are visible:

1. **Specifications** are *declarations* — Storybook stories, `argTypes`, props interfaces.
2. **Observations** are *recordings* — snapshots, Playwright runs, RTL assertions.
3. **Derivations** are *computed* — the inferred summary from code.

Specifications and observations are *partial*: a snapshot tells you what one configuration rendered, not what any other configuration would render. The *derivation* is the only shape that enumerates all paths, and that's what suss produces.

**The interesting findings for React come from inter-shape comparison:**

- Does the inferred summary cover every Storybook scenario? (Specification satisfied?)
- Does every snapshot correspond to an inferred path? (Observation ⊆ derivation, otherwise the code drifted.)
- Does Playwright's event-chain match the inferred handler unit's effects? (Behavioral agreement across shapes.)
- Does the Storybook spec enumerate paths the code can actually reach? (Spec feasibility.)

That's multi-axis contract agreement, not the single-axis `checkContractConsistency` we built for HTTP. It's an extension of `checkContractAgreement` (the Layer 2 pass) where "different sources" now means "different contract *shapes*," not just different schema flavors.

### Figma is punted

The earlier plan listed Figma as a primary stub source. It's deferred. Three reasons:

1. **Not usually committed.** Figma files live in a SaaS product; the repo at best contains a URL reference in a comment.
2. **Not definitive.** Wireframes often diverge from ship; Figma files routinely live-edit after the code lands. "The design" as a file is rarely the contract.
3. **Extraction is expensive for signal we can't yet act on.** The Figma REST API + naming-convention mapping is a lot of integration work before we know what cross-shape check it feeds.

When / if it comes back, it'll be via an explicit, opt-in `@suss/contract-figma-url` that reads a URL reference and reports a `lowConfidence` visual-intent signal — never a source of hard findings. Not on the critical path.

## Why Storybook first

The contract shapes that survive the punt are **Storybook + inferred (+ later Playwright + snapshots)**. Storybook is the first stub we'll build because:

- Storybook stories are usually committed in the repo (`*.stories.tsx`), unlike Figma.
- CSF format (Component Story Format) is statically parsable — no execution required for basic extraction.
- `args` + `argTypes` provide a canonical spec: "here's a set of prop configurations this component supports."
- Optional `play` functions are behavioral observations — they pair directly with event-handler code units.

Storybook alone is sufficient to prove the multi-shape claim: inferred-derivation vs Storybook-specification covers the first meaningful cross-shape finding, and the machinery generalizes to Playwright and snapshots additively.

## Phased plan

Each phase is scoped to answer specific forcing-function questions about the IR and checker. If a phase surfaces questions that invalidate later phases' assumptions, we stop and redesign — cheaper to discover the wrong shape at Phase 1.6 than at Phase 3.

### Phase 0 — Foundation docs ✅

`docs/contracts.md` captures the contract-shape taxonomy and epistemic character. `docs/roadmap-react.md` (this doc) captures the React plan. `docs/boundary-semantics.md` captures the transport/semantics/recognition layering.

### Phase 1 — Inferred summaries for React components (in progress)

Build `@suss/framework-react` (pattern pack) + adapter extensions so the TypeScript adapter can discover components, extract props, and walk JSX trees. Split into sub-phases per code-unit kind so each one forcing-functions its own IR question.

| Sub-phase | Status | Output |
|---|---|---|
| 1.1 Function-component discovery + JSX-return terminal | ✅ | Default-exported function components → `component` code units; JSX return → `render` terminal carrying root element name. `jsxReturn` TerminalMatch variant. |
| 1.2 Destructured-prop Inputs + type resolution | ✅ | `componentProps` InputMappingPattern — one Input per destructured name with TypeScript-resolved type; whole-object fallback for non-destructured. |
| 1.3 Hook-call recognition (`useState`, `useRef`, etc.) | ✅ (by-product) | Captured for free via existing `extractDependencyCalls` — hooks surface when their return values are referenced in conditions or outputs. |
| 1.5b Effect-body capture + fall-through terminals | ✅ | Bare expression-statement calls in a function body become `invocation` `RawEffect`s attached to the default branch (`setCount(n); onChange(n);`). New `functionFallthrough` `TerminalMatch` variant lets packs opt into "emit a default transition when no explicit return/throw covers the exit path" — HTTP packs deliberately don't opt in so bug-shaped handlers stay empty for gap detection; sub-unit scaffolding (React handlers, `useEffect` bodies, Node `.on(...)` listeners) includes it. Calls whose source line matches a matched terminal (e.g. `res.json(...)` in Express) are filtered to avoid double-counting. |
| 1.4 Inline JSX conditionals (`cond && <X/>`, ternaries) | ✅ | `RenderNode` gained a `conditional` variant: `{type: "conditional"; condition; then; else: RenderNode \| null}`. Adapter decomposes `{cond && <X/>}`, `{cond ? <A/> : <B/>}`, `{cond ? <X/> : null}`, and handles `false` / `undefined` no-render sentinels + parenthesised JSX. `{cond ? nonJsx : <Fallback/>}` promotes the JSX branch with a textually-negated condition `!(cond)`. `\|\|`, `.map()`, and other non-conditional expressions remain as opaque `expression` nodes. Condition text is preserved verbatim for v0 — structured predicate decomposition of the test expression is a follow-up. |
| 1.5 Event handlers as separate code units | ✅ | Each `onClick={fn}` / inline `onClick={() => ...}` becomes its own `handler`-kind summary sharing the component's identity prefix. Names: `ComponentName.functionName` for named locals, `ComponentName.tag.propName[#N]` for inline arrows. Prop-delegating refs (`onClick={props.onDelete}`) are skipped. Adapter post-pass (`synthesizeReactHandlers`), pack stays declarative. Effect-body extraction (bare `setState()` call statements) still limited — 1.5b follow-up. |
| 1.6 Nested render tree (Output.render.root) | ✅ | `RenderNode` recursive IR (element / text / expression); `Output.render.root` carries the full tree with children. |
| 1.6b JSX attributes on render-tree element nodes | ✅ | `RenderNode.element` gained optional `attrs?: Record<string, string>` — every JSX attribute mapped to its raw value source text (string literals include quotes, expressions include full source, boolean shorthand maps to `""`). Spreads (`{...props}`) surface as `...exprText` keys. Framework-agnostic — no React-specific interpretation in the adapter. Downstream consumers (Storybook matcher, cross-shape checker) combine attrs with the pack's naming rule to resolve handler summary identities on demand (e.g. `attrs.onClick = "handleSubmit"` + `Form.handleSubmit` naming → summary reference). |
| 1.7 `useEffect` bodies as code units | ✅ | Each `useEffect(fn, deps?)` becomes a `handler`-kind summary (`metadata.react.kind = "effect"`) named `ComponentName.effect#N`, indexed in source order. Deps-array source text captured on `metadata.react.deps` (null when absent = re-runs every render; `"[]"` = mount-only). Inputs are deferred — `useEffect` callbacks close over their deps rather than receiving them positionally, so the positional-param input mapping is empty. Forcing-function answer: one summary per useEffect with its branches/effects is sufficient; no cleanup sub-unit needed at this level — cleanup returns show up as the effect's own `return` transitions naturally. |

**Forcing-function questions this phase answers (updated):**

- Is `Output.render` rich enough to describe what a component produces? (Phase 1.6 shipped.)
- How does the pattern-pack interface support multi-unit-per-file discovery? (Phase 1.5.)
- Do event handlers and effects need new `CodeUnitKind`s or fit inside `component`/`hook`? (Phase 1.5 / 1.7.)
- How does `confidence` scale? React has tons of dynamic JSX the extractor can't resolve. (Continuous — each sub-phase observes.)

**Explicitly deferred throughout Phase 1:**

- React Server Components (async bodies, server-only APIs)
- Class components (functional components are the dominant style)
- HOCs and render props (higher-order composition; hard to track through)
- Custom hooks (callable like any function — extraction is recursive; no special case needed for v0)

### On Storybook's scope

Storybook is a useful *proof of concept* for the cross-shape machinery — it let us build `subUnits`, cross-shape finding kinds, and the extract-stub-check pipeline against a tractable target. But Storybook covers reused component scenarios; the interesting screen states in a real app (full-page flows, multi-component interactions, error states that only appear through real routing) won't be in Storybook anyway.

The higher-value observation sources are **test runtimes that drive the whole UI**: Playwright, Cypress, Vitest + Testing Library, Storybook portable stories composed into those runtimes (`composeStories`). Their play-function / spec sequences are *behavioral observations* in the contracts-taxonomy sense — `await userEvent.click(button)` → inferred handler should fire; `expect(page.getByText("Saved"))` → inferred render should produce that text. Those findings aren't catchable by TypeScript, and they're the ones worth paying for.

Storybook-as-stub stays shipped for the component-level coverage it does give; further Storybook investment (snapshots, play functions) gets folded into a broader observation-stub story alongside Playwright / Cypress. See Phase 4 below.

### Phase 2 — Storybook as stub source (v0 shipped)

`@suss/contract-storybook` reads `.stories.ts[x]` files statically (no execution) and emits `BehavioralSummary[]` with `kind: "component"`. Each named-export story becomes one summary:

- `identity.name` = `{component}.{story}` (e.g. `Button.Primary`)
- `identity.boundaryBinding` = `{ protocol: "in-process", framework: "react" }`
- `inputs` = one `parameter` Input per arg, with the arg value's source text preserved on `shape.ref.name`
- `transitions` = one default `render` transition naming the component
- `metadata.component.storybook.{story, component, args, provenance: "independent"}`
- `confidence.source: "stub"`, `level: "medium"`

Covers CSF3 shape variants: `const meta = {...}; export default meta;`, direct `export default {...}`, and `{...} satisfies Meta<typeof T>` on both meta and stories. Shorthand-property args captured.

**Deferred past v0:**
- `play` function parsing (interactive story event sequences) — will cross-reference Phase 1.5 handler units once Phase 3 lands
- `argTypes` per-arg metadata (control type, options)
- Cross-file component resolution — currently records the component's identifier name; doesn't follow the import to a module path
- CSF1 / MDX / decorators / parameters

**Forcing-function questions, now answered:**

- *Storybook stubs can be authored without executing stories* ✓ — CSF3 is statically parsable.
- *Pairing key for component boundaries is `(componentName, storyName)` with framework `react`* — distinct from HTTP's `(method, path)`. Confirms the need for multi-variant `BoundaryBinding.semantics` when the `BoundarySemantics` refactor lands.

**Still open (Phase 3 material):**
- Does `checkContractAgreement` generalize to inferred-vs-Storybook?
- Do play-function sequences pair with handler sub-units?

### Phase 3 — Cross-shape contract agreement for React (v0 shipped)

`checkComponentStoryAgreement` in `@suss/checker` pairs Storybook stubs with inferred React component summaries by component name and emits two finding kinds:

- `scenarioArgUnknown` — story references a prop the component doesn't declare. Catches outdated stories and renamed props.
- `scenarioCoverageGap` — a prop that gates a conditional branch in the component's inferred logic has no story supplying it; the branches depending on that prop have no declared scenario exercising them. Walks structured `Predicate` / `ValueRef` IR (with a source-text regex fallback for opaque predicates) to collect gating input names.

Deliberately **not** emitted: arg-value-vs-declared-type mismatches. TypeScript already catches `label: 42` against `label: string` via CSF3's `satisfies Meta<typeof Component>`. Duplicating that check would be noise.

Runs inside `checkAll` alongside `checkContractAgreement`. Finding kind choices favoured specificity over reusing `contractDisagreement`: story vs component isn't quite "two contracts disagreeing"; it's "scenario vs implementation," which reads as its own finding kind.

**Integration test:** `packages/cli/src/storybook-integration.test.ts` runs the full pipeline — extract React fixtures, stub Storybook fixtures, `checkAll` — and asserts the `scenarioArgUnknown` kind fires against `Button.stories.tsx`'s `Disabled` story (uses a `disabled` prop that Button.tsx doesn't declare). UserCard.stories.tsx's `Loaded` story properly covers the `user` prop so no coverage gap fires there — positive-case assertion.

**Deferred past v0:**
- Inferred handlers vs Storybook `play` sequences — needs play-function parsing
- Inferred render vs Storybook snapshot content — needs snapshot stub
- Branch-value coverage ("component has branch for `user.deletedAt === true` but no story provides such a user") — needs predicate-level partial evaluation against arg values
- Observation-shape cross-checks (Playwright / Cypress) — see Phase 4

### Phase 4 — Observation-shape stubs (Playwright / Cypress / portable stories)

The highest-signal cross-shape findings for React aren't in Storybook args — they're in *observable interaction sequences* that full-app test runtimes capture. Parsing those gets us findings that can't come from TypeScript, Storybook, or inferred-summary checking alone:

- **Dead click:** a Playwright test does `userEvent.click(button)` on a `<button>` the inferred render tree has no handler for.
- **Asserted text the render can't produce:** `expect(page.getByText("Welcome back"))` but the inferred render tree under the test's implied args never emits that text.
- **State assertion no handler reaches:** `await waitFor(() => expect(valueIsX))` but no handler's inferred effects produce that state.

Stubs to build when ready: `@suss/contract-playwright` (parses `.spec.ts` files), `@suss/contract-cypress` (similar for Cypress), Storybook `play` function parsing (folded into `@suss/contract-storybook`). Each emits observation-kind summaries that the cross-shape checker pairs against handler sub-units and render-tree elements. Prioritise over further Storybook investment — play functions + E2E specs are where the behavioural surface actually lives for non-trivial UIs.

### Phase 4 — Additional observation stubs (opportunistic)

Snapshot reader (`__snapshots__/*.snap` → partial observation summaries) and Playwright reader (behavioral observations that pair with handler units) land as additive packs once Phase 3 has proven the cross-shape agreement machinery. Neither forces new IR work; both feed the same checker extension.

## IR and checker changes the plan implies

Captured here so refactor work is visible, not incidental:

1. **`BoundaryBinding` generalization.** `(protocol, method, path, framework)` becomes `transport + semantics(variant) + recognition`. React's semantics variant is `{ kind: "react-component-unit", module, componentName, unitKind: "render" | "handler" | "effect", unitName? }`. Unlocks Phase 1.5 and Phase 2 pairing.

2. **`BoundarySemantics` interface.** Pairing, discriminator extraction, payload extraction abstracted over boundary kind. HTTP impl is the first; React impl is the second. Implementation blocks Phase 2 in any clean form.

3. **`Output.render.root`** ✅ — rich recursive `RenderNode` tree shipped in Phase 1.6.

4. **Multi-unit discovery in `PatternPack`.** Current pack says "default export → one component." Phase 1.5 needs "default export → one component unit AND one handler unit per `onClick`-like prop in the render tree." The pack interface grows a multi-discovery case, or the adapter synthesizes sibling units from the render tree (preferred; keeps the pack declarative).

5. **Contract shape tagging in metadata.** `metadata.component.storybook.*`, `metadata.component.snapshot.*`, etc. — sibling namespaces to `metadata.http.*`. Extends the pattern from `docs/behavioral-summary-format.md`.

## What we're explicitly deferring

So the shape of "done" is stated:

- **Figma as a primary stub source** (see above).
- **React Server Components** — async component bodies, server-only APIs, streaming.
- **Class components** — nearly-dead form in new React.
- **HOCs and render props** — higher-order composition; hard to track through.
- **Custom hooks as separate code units** — extractable recursively as-needed; no pre-planned treatment.
- **Database boundaries (RDS / Postgres / Prisma).** Bigger latent value than React; picked up after React. Schema-shaped, so doesn't stress contracts taxonomy the way React does.
- **GraphQL.** Same transport as HTTP but different semantics. Useful as a cleanup case after React has forced the abstraction; not worth tackling before.
- **Pact-style example contracts for React.** Storybook + snapshots cover the spec + observation slots we need.

## What this commits us to

- The abstract claim in `boundary-semantics.md` becomes concrete at Phase 1.5 / Phase 2 (first multi-unit semantics, first non-HTTP pairing).
- Suss's positioning sharpens: "behavioral analysis for code ↔ observable-behavior boundaries, with contract checking across whatever shapes the domain has." HTTP-with-OpenAPI was the first instance; React-with-Storybook is the second.
- The checker's current `checkContractAgreement` machinery is a down-payment on the multi-axis logic Phase 3 needs. Good.
- Future packs can be assessed against this framework: what's the boundary? what are the code units? what's the observable channel? what contract shapes exist in that domain? — without fresh design each time.

## Open questions that'll get answered by doing

On the critical path; don't try to pre-answer:

1. How faithful is the render tree when the rendered child component is itself a variable / HOC / conditional? Phase 1.4 finds out.
2. Does the handler-as-unit framing work for inline arrow functions, named handlers, and hook-returned handlers without special-casing? Phase 1.5 finds out.
3. Does Storybook's CSF format yield useful stubs via static parsing alone, or does it need execution? Phase 2 finds out.
4. Does the concept-design vision survive contact with the multi-axis finding model — or does it surface a design flaw in the current checker? Phase 3 finds out.

If any of these bend the design away from what this doc assumes, we update the doc first and rebuild the plan before continuing.
