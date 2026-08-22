# React roadmap

Strategic plan for React as suss's first non-HTTP boundary. Writing the direction down means the context survives compaction and the implementation stays on-thesis. Phases we have shipped are marked ✅. Everything else is design until the phase before it has answered its forcing-function questions.

Related: [`boundary-semantics.md`](../docs/boundary-semantics.md) (transport / semantics / recognition layering), [`contracts.md`](../docs/contracts.md) (the five-shape contract taxonomy).

## Where this fits in the bigger picture

Suss today ships one concrete boundary kind: HTTP. The types the IR defines are protocol-agnostic, but the checker, the pairing, and the packs all converged on HTTP. We can only claim the "behavioral understanding platform" positioning if we can show the abstraction works for a second boundary kind.

React is the first forcing function we're implementing. Why React rather than GraphQL (same transport, different semantics), RDS/Postgres (different substrate entirely, biggest latent value), or Vue (simpler technical case):

- **Adoption reach.** React has the largest developer base of the realistic targets.
- **Hardest declaration density.** React formalizes the least of any mainstream component framework. No `defineEmits`, no `defineSlots`: callbacks are arbitrary props, children are ad hoc. If the IR survives React, it survives easier cases by induction.
- **Forces the `BoundarySemantics` refactor.** React's boundary (component ↔ DOM) shares no structure with HTTP's (client ↔ server). Pairing by `(method, path)` doesn't apply, and neither do status codes. The checker can't pretend everything looks like REST, so it has to generalize.

## React components are N code units, not one

This is the key framing decision, and it's worth saying plainly before the phases.

A React component as a source-file concept is *not* one behavioral unit. It's a cluster:

- The **render body** runs on every render: inputs are props/state/context, output is a JSX tree, effects are reads of state and invocations of child components.
- Each **event handler** is its own entry point: inputs are synthetic event + closed-over state/props, outputs are state mutations and callback-prop invocations.
- Each **`useEffect` body** is its own unit: inputs are the dependency array's values, outputs are side-effects (subscriptions, network calls, DOM writes), with a cleanup sub-unit.
- Each **`useMemo` / `useCallback` body** has the same form as a render-fragment, keyed on deps.

They share an identity (the same component module and export) and they share state (hooks and closures), but they have distinct inputs, distinct outputs, and fire at distinct times. Treating them as one "lifecycle summary" would run semantically different events together and lose the information that makes React findings useful.

This reuses the HTTP abstraction without new concepts. A single Express handler file can register `app.get("/users", h1)` and `app.post("/users", h2)`: two code units that share a module. In the same way, a React component file exports one default component whose render, handlers, and effects are several code units that share an identity prefix. The `BoundaryBinding.semantics` layer tells them apart (`render` vs `event-handler(name="onClick")` vs `effect(index=0)`).

This is also where the **theoretical grounding** comes in. In Daniel Jackson's concept-design framework (MIT; see [*The Essence of Software*](https://essenceofsoftware.com/), [*Concept Design Moves*](https://people.csail.mit.edu/dnj/publications/nfm-design-moves-22.pdf), [*What You See Is What It Does*](https://arxiv.org/abs/2508.14511)), a concept is a self-contained unit with state + actions + purpose, and synchronizations are rules of the form "when action A₁ in concept C₁ happens, action A₂ in concept C₂ happens." Under that framing:

- A suss code unit ≈ a concept's action (one triggerable behavior)
- Shared closure/hook state ≈ the concept's state
- `setState` → re-render is a synchronization: "when `onClick.setState(n)` fires, `render` observes n and produces new JSX"
- The cluster of units sharing a React component identity ≈ one concept instance

We don't adopt Jackson's vocabulary wholesale ("purpose" requires intent declarations suss doesn't have), but the structural mapping is close enough that the N-units-per-component decision is theoretically grounded, not only pragmatic.

Two deliberate divergences from Jackson worth stating:

1. **Intent is absent.** A Jackson concept declares its purpose top-down, while suss infers behavior bottom-up. The nearest stand-in is a `contractDisagreement` finding: it fires when observed behavior contradicts a declared contract, which is as close as suss gets to "purpose violated."
2. **Genericity is absent.** Jackson concepts are reusable design primitives (like `Upvote`, `Follow`). Suss summaries are instance-specific. The goal of reducing opaqueness recursively leaves open a path where recurring clusters show up as concept candidates, but that's future work, not v0.

Further reading: Daniel Jackson, [*Concept Design Moves*](https://people.csail.mit.edu/dnj/publications/nfm-design-moves-22.pdf) (NFM 2022); Eagon Meng & Daniel Jackson, [*What You See Is What It Does*](https://arxiv.org/abs/2508.14511) (SPLASH Onward! 2025); Jackson, [*The Essence of Software*](https://essenceofsoftware.com/) (Princeton, 2021). The long-form mapping (audience indexing, failure modes, PRDs as concept declarations) is in [`concept-design.md`](../docs/internal/concept-design.md).

## The boundary React actually has

Every React component source file looks like a function that takes props and returns JSX. But where's the *boundary*, the point where behavior becomes observable?

Not between parent and child component. They're both providers composing into the same output.

Not between component and React runtime: that's a platform relationship (like handler ↔ Express), not a contract between two peers.

The boundary is **component source ↔ DOM / user**. The DOM is where component behavior becomes observable. Snapshots, Playwright specs, visual regression baselines, and screen-reader behavior all describe what a React component does at the DOM boundary rather than at the component interface, and so does every other existing contract shape for React.

This maps directly to the HTTP case:

| HTTP | React |
|---|---|
| Handler source | Component code units (render, handlers, effects) |
| HTTP message on the wire | Rendered DOM tree + dispatched events |
| Client code | DOM (observed by tests, users, screen readers, visual-regression) |
| OpenAPI describes the wire | Storybook / snapshots / Playwright describe the DOM |

So a React boundary in suss is `(module, component-name, unit-kind)`. The pairing key is the component identity plus the unit kind. The "consumer" side comes from whatever stub shapes someone wrote (Storybook first of all).

## Contract shapes in React are plural and partial

This is the widest departure from HTTP. For an HTTP endpoint, one canonical contract shape (OpenAPI or its framework-specific equivalent) usually contains the whole declared contract. For React, *no single shape covers a full component contract*:

| Shape | Captures | Coverage | Epistemic character |
|---|---|---|---|
| TypeScript props interface | Input type surface | Full (for types) | Signature; necessary, not sufficient |
| Storybook stories | Named canonical scenarios + `args` + optional `play` | Curated set | Partial **specification** |
| Snapshots (Jest / Vitest) | Rendered tree for specific tests | Tested instances | Partial **observation** |
| Playwright / RTL | Event → effect sequences | Tested interactions | Behavioral **observation** |
| Figma / design tokens | Visual intent | Designer's scenarios | Design-source-of-truth (see punt below) |
| Inferred summary (from code) | All branching paths, state reads, effects | Full (for code behavior) | Structural **derivation** |

Three distinct kinds of epistemic contribution are visible:

1. **Specifications** are *declarations*: Storybook stories, `argTypes`, props interfaces.
2. **Observations** are *recordings*: snapshots, Playwright runs, RTL assertions.
3. **Derivations** are *computed*: the inferred summary from code.

Specifications and observations are *partial*: a snapshot tells you what one configuration rendered, and nothing about what any other configuration would render. The *derivation* is the only shape that lists every path, and that's what suss produces.

**The interesting findings for React come from inter-shape comparison:**

- Does the inferred summary cover every Storybook scenario? (Specification satisfied?)
- Does every snapshot correspond to an inferred path? (Observation ⊆ derivation, otherwise the code drifted.)
- Does Playwright's event-chain match the inferred handler unit's effects? (Behavioral agreement across shapes.)
- Does the Storybook spec enumerate paths the code can actually reach? (Spec feasibility.)

That's multi-axis contract agreement, not the single-axis `checkContractConsistency` we built for HTTP. It extends `checkContractAgreement` (the Layer 2 pass) so that "different sources" now covers "different contract *shapes*" and not only different schema flavors.

### Figma is punted

The earlier plan listed Figma as a primary stub source. It's deferred. Three reasons:

1. **Not usually committed.** Figma files live in a SaaS product; the repo at best contains a URL reference in a comment.
2. **Not definitive.** Wireframes often diverge from what ships, and people keep editing Figma files after the code lands. A design file is rarely the contract.
3. **Extraction is expensive for signal we can't yet act on.** The Figma REST API plus a mapping from naming conventions is a lot of integration work to do before we know which cross-shape check it feeds.

If it comes back, it will come back as an explicit, opt-in `@suss/contract-figma-url` that reads a URL reference and reports a `lowConfidence` visual-intent signal, never a source of hard findings. It is not on the critical path.

## Why Storybook first

The contract shapes that survive the punt are **Storybook + inferred (+ later Playwright + snapshots)**. Storybook is the first stub we'll build because:

- People usually commit Storybook stories to the repo (`*.stories.tsx`), which they don't do with Figma.
- We can parse the CSF format (Component Story Format) statically, so basic extraction doesn't have to run anything.
- `args` and `argTypes` give a canonical spec: "here's a set of prop configurations this component supports."
- Optional `play` functions are behavioral observations, and they pair directly with event-handler code units.

Storybook on its own is enough to prove the multi-shape claim. Comparing the inferred derivation against the Storybook specification gives us the first meaningful cross-shape finding, and the same machinery extends to Playwright and snapshots by addition.

## Phased plan

Each phase is scoped to answer specific forcing-function questions about the IR and the checker. If a phase raises questions that invalidate what a later phase assumes, we stop and redesign. Finding out we got the design wrong at Phase 1.6 is cheaper than finding out at Phase 3.

### Phase 0: Foundation docs ✅

`docs/contracts.md` sets out the contract-shape taxonomy and epistemic character. `docs/roadmap-react.md` (this doc) sets out the React plan. `docs/boundary-semantics.md` sets out the transport / semantics / recognition layering.

### Phase 1: Inferred summaries for React components (in progress)

Build `@suss/framework-react` (a pattern pack) plus adapter extensions, so the TypeScript adapter can discover components, extract props, and walk JSX trees. We split the work into one sub-phase per code-unit kind, so each one forces its own IR question.

| Sub-phase | Status | Output |
|---|---|---|
| 1.1 Function-component discovery + JSX-return terminal | ✅ | Default-exported function components become `component` code units. A JSX return becomes a `render` terminal with the root element's name on it. New `jsxReturn` TerminalMatch variant. |
| 1.2 Destructured-prop Inputs + type resolution | ✅ | New `componentProps` InputMappingPattern: one Input per destructured name, with the type TypeScript resolves for it. When the props aren't destructured it falls back to the whole object. |
| 1.3 Hook-call recognition (`useState`, `useRef`, etc.) | ✅ (by-product) | The existing `extractDependencyCalls` picks these up for free: a hook shows up when something references its return value in a condition or an output. |
| 1.5b Effect-body capture + fall-through terminals | ✅ | Bare expression-statement calls in a function body become `invocation` `RawEffect`s attached to the default branch (`setCount(n); onChange(n);`). A new `functionFallthrough` `TerminalMatch` variant lets a pack opt into "emit a default transition when no explicit return or throw covers the exit path". The HTTP packs deliberately don't opt in, so a buggy-looking handler stays empty and gap detection can see it. The sub-unit scaffolding (React handlers, `useEffect` bodies, Node `.on(...)` listeners) does opt in. We filter out calls whose source line matches a terminal we already matched (`res.json(...)` in Express, for instance) so nothing gets counted twice. |
| 1.4 Inline JSX conditionals (`cond && <X/>`, ternaries) | ✅ | `RenderNode` gained a `conditional` variant: `{type: "conditional"; condition; then; else: RenderNode \| null}`. The adapter breaks down `{cond && <X/>}`, `{cond ? <A/> : <B/>}`, and `{cond ? <X/> : null}`, and it handles the `false` / `undefined` no-render sentinels and parenthesised JSX. For `{cond ? nonJsx : <Fallback/>}` it promotes the JSX branch and negates the condition textually to `!(cond)`. `\|\|`, `.map()`, and other non-conditional expressions stay as opaque `expression` nodes. v0 keeps the condition text word for word. Breaking the test expression down into a structured predicate is a follow-up. |
| 1.5 Event handlers as separate code units | ✅ | Each `onClick={fn}` / inline `onClick={() => ...}` becomes its own `handler`-kind summary that shares the component's identity prefix. Named locals are called `ComponentName.functionName` and inline arrows are called `ComponentName.tag.propName[#N]`. A handler that only forwards a prop (`onClick={props.onDelete}`) is skipped. An adapter post-pass (`synthesizeReactHandlers`) does this, so the pack stays declarative. Pulling effects out of a body (bare `setState()` call statements) is still limited; 1.5b follows up. |
| 1.6 Nested render tree (Output.render.root) | ✅ | `RenderNode` is a recursive IR node (element, text, or expression), and `Output.render.root` contains the full tree with its children. |
| 1.6b JSX attributes on render-tree element nodes | ✅ | `RenderNode.element` gained an optional `attrs?: Record<string, string>`, which maps every JSX attribute to the raw source text of its value (a string literal includes its quotes, an expression includes its full source, and boolean shorthand maps to `""`). A spread (`{...props}`) shows up as a `...exprText` key. This is framework-agnostic: the adapter reads no React-specific meaning into it. Downstream consumers (the Storybook matcher, the cross-shape checker) combine the attributes with the pack's naming rule to work out handler summary identities when they need them (for example `attrs.onClick = "handleSubmit"` plus the `Form.handleSubmit` naming gives a summary reference). |
| 1.7 `useEffect` bodies as code units | ✅ | Each `useEffect(fn, deps?)` becomes a `handler`-kind summary (`metadata.react.kind = "effect"`) named `ComponentName.effect#N` and numbered in source order. The source text of the deps array is recorded on `metadata.react.deps` (null when there is no array, meaning the effect re-runs every render; `"[]"` means it runs only on mount). Inputs are deferred, because a `useEffect` callback closes over its deps instead of receiving them as parameters, which leaves the positional-parameter input mapping empty. The forcing-function answer: one summary per useEffect, with its branches and effects, is enough. Nothing needs a separate cleanup sub-unit at this level, because a cleanup return already shows up as one of the effect's own `return` transitions. |

**Forcing-function questions this phase answers (updated):**

- Is `Output.render` rich enough to describe what a component produces? (Phase 1.6 shipped.)
- How does the pattern-pack interface support finding several units in one file? (Phase 1.5.)
- Do event handlers and effects need new `CodeUnitKind`s, or do they fit inside `component` and `hook`? (Phase 1.5 / 1.7.)
- How does `confidence` scale? React has tons of dynamic JSX the extractor can't resolve. (This runs throughout; each sub-phase watches it.)

**Explicitly deferred throughout Phase 1:**

- React Server Components (async bodies, server-only APIs)
- Class components (functional components are the dominant style)
- HOCs and render props (higher-order composition; hard to track through)
- Custom hooks (you call them like any other function, so extraction recurses into them and v0 needs no special case)

### On Storybook's scope

Storybook is a useful *proof of concept* for the cross-shape machinery: it let us build `subUnits`, the cross-shape finding kinds, and the extract-stub-check pipeline against a target we could handle. But Storybook covers scenarios for components people reuse. The interesting screen states in a production app (full-page flows, several components interacting, error states that only appear once you route through the app) won't be in Storybook anyway.

The higher-value observation sources are **test runtimes that drive the whole UI**: Playwright, Cypress, Vitest with Testing Library, and Storybook portable stories composed into those runtimes (`composeStories`). Their play functions and spec sequences are *behavioral observations* in the sense the contracts taxonomy uses: `await userEvent.click(button)` means the inferred handler should fire, and `expect(page.getByText("Saved"))` means the inferred render should produce that text. TypeScript can't catch those findings, and they're the ones worth paying for.

The Storybook stub stays shipped for the component-level coverage it does give us. Any further work on Storybook (snapshots, play functions) folds into a broader observation-stub effort alongside Playwright and Cypress. See Phase 4 below.

### Phase 2: Storybook as stub source (v0 shipped)

`@suss/contract-storybook` reads `.stories.ts[x]` files statically (no execution) and emits `BehavioralSummary[]` with `kind: "component"`. Each named-export story becomes one summary:

- `identity.name` = `{component}.{story}` (e.g. `Button.Primary`)
- `identity.boundaryBinding` = `{ protocol: "in-process", framework: "react" }`
- `inputs` = one `parameter` Input per arg, with the source text of the arg's value kept on `shape.ref.name`
- `transitions` = one default `render` transition that gives the component's name
- `metadata.component.storybook.{story, component, args, provenance: "independent"}`
- `confidence.source: "stub"`, `level: "medium"`

It covers the CSF3 variants: `const meta = {...}; export default meta;`, a direct `export default {...}`, and `{...} satisfies Meta<typeof T>` on both the meta and the stories. It also picks up args written as shorthand properties.

**Deferred past v0:**
- Parsing `play` functions (the event sequences an interactive story runs). Once Phase 3 lands, they will cross-reference the handler units from Phase 1.5
- The per-arg metadata in `argTypes` (control type, options)
- Resolving a component across files. It currently records the component's identifier name and doesn't follow the import to a module path
- CSF1 / MDX / decorators / parameters

**Forcing-function questions, now answered:**

- *You can write Storybook stubs without executing the stories* ✓, because CSF3 can be parsed statically.
- *The pairing key for a component boundary is `(componentName, storyName)` with framework `react`*, which differs from HTTP's `(method, path)`. That confirms we need a multi-variant `BoundaryBinding.semantics` when the `BoundarySemantics` refactor lands.

**Still open (Phase 3 material):**
- Does `checkContractAgreement` generalize to inferred-vs-Storybook?
- Do play-function sequences pair with handler sub-units?

### Phase 3: Cross-shape contract agreement for React (v0 shipped)

`checkComponentStoryAgreement` in `@suss/checker` pairs Storybook stubs with inferred React component summaries by component name and emits two finding kinds:

- `scenarioArgUnknown`: a story references a prop the component doesn't declare. This catches out-of-date stories and renamed props.
- `scenarioCoverageGap`: a prop gates a conditional branch in the component's inferred logic and no story supplies that prop, so no declared scenario exercises the branches that depend on it. The check walks the structured `Predicate` / `ValueRef` IR to collect the names of the gating inputs, and falls back to a regex over the source text when a predicate is opaque.

Deliberately **not** emitted: arg-value-vs-declared-type mismatches. TypeScript already catches `label: 42` against `label: string` via CSF3's `satisfies Meta<typeof Component>`. Duplicating that check would be noise.

It runs inside `checkAll` alongside `checkContractAgreement`. We picked specific finding kinds rather than reusing `contractDisagreement`, because a story against a component isn't quite "two contracts disagreeing". It is "scenario against implementation", and that deserves a finding kind of its own.

**Integration test:** `packages/cli/src/storybook-integration.test.ts` runs the whole pipeline (extract the React fixtures, stub the Storybook fixtures, run `checkAll`) and asserts that `scenarioArgUnknown` fires against the `Disabled` story in `Button.stories.tsx`, which uses a `disabled` prop that Button.tsx doesn't declare. The test also asserts the positive case: the `Loaded` story in UserCard.stories.tsx covers the `user` prop properly, so no coverage gap fires there.

**Deferred past v0:**
- Inferred handlers against Storybook `play` sequences. We need to parse play functions first
- Inferred render against the content of a Storybook snapshot. We need a snapshot stub first
- Branch-value coverage ("the component has a branch for `user.deletedAt === true` but no story provides such a user"). We need to partially evaluate predicates against arg values first
- Observation-shape cross-checks (Playwright / Cypress): see Phase 4

### Phase 4: Observation-shape stubs (Playwright / Cypress / portable stories)

The cross-shape findings with the most signal for React aren't in Storybook args. They're in the *observable interaction sequences* that a full-app test runtime records. Parsing those gets us findings that TypeScript, Storybook, or inferred-summary checking cannot give us on their own:

- **Dead click:** a Playwright test does `userEvent.click(button)` on a `<button>` the inferred render tree has no handler for.
- **Asserted text the render can't produce:** `expect(page.getByText("Welcome back"))` but the inferred render tree under the test's implied args never emits that text.
- **State assertion no handler reaches:** `await waitFor(() => expect(valueIsX))` but no handler's inferred effects produce that state.

Stubs to build when ready: `@suss/contract-playwright` (parses `.spec.ts` files), `@suss/contract-cypress` (similar for Cypress), Storybook `play` function parsing (folded into `@suss/contract-storybook`). Each one emits observation-kind summaries that the cross-shape checker pairs against handler sub-units and render-tree elements. We should do this before putting more work into Storybook, because play functions and E2E specs are where the behavioural surface of a non-trivial UI actually lives.

### Phase 4: Additional observation stubs (opportunistic)

A snapshot reader (turning `__snapshots__/*.snap` into partial observation summaries) and a Playwright reader (behavioral observations that pair with handler units) arrive as extra packs once Phase 3 has proven the cross-shape agreement machinery. Neither one forces new IR work, and both feed the same checker extension.

## IR and checker changes the plan implies

These are written down here so the refactor work is visible rather than incidental:

1. **`BoundaryBinding` generalization.** `(protocol, method, path, framework)` becomes `transport + semantics(variant) + recognition`. React's semantics variant is `{ kind: "react-component-unit", module, componentName, unitKind: "render" | "handler" | "effect", unitName? }`. This is what unlocks pairing in Phase 1.5 and Phase 2.

2. **`BoundarySemantics` interface.** Pairing, discriminator extraction, and payload extraction all get abstracted over the boundary kind. The HTTP implementation is the first and the React one is the second. Until this exists, we can't build Phase 2 in any maintainable form.

3. **`Output.render.root`** ✅. Rich recursive `RenderNode` tree shipped in Phase 1.6.

4. **Multi-unit discovery in `PatternPack`.** The current pack says "a default export gives one component." Phase 1.5 needs "a default export gives one component unit AND one handler unit for every `onClick`-like prop in the render tree." Either the pack interface grows a case for discovering several units, or the adapter builds the sibling units from the render tree. We prefer the second, because it keeps the pack declarative.

5. **Tagging the contract shape in metadata.** `metadata.component.storybook.*`, `metadata.component.snapshot.*`, and so on, all sitting alongside `metadata.http.*`. This extends the pattern from `docs/behavioral-summary-format.md`.

## What we're explicitly deferring

So that we've said what "done" means:

- **Figma as a primary stub source** (see above).
- **React Server Components**: async component bodies, server-only APIs, streaming.
- **Class components**: nearly-dead form in new React.
- **HOCs and render props**: higher-order composition; hard to track through.
- **Custom hooks as separate code units**: extractable recursively as-needed; no pre-planned treatment.
- **Database boundaries (RDS / Postgres / Prisma).** There is more latent value here than in React, and we pick these up after React. They're schema-shaped, so they don't stress the contracts taxonomy the way React does.
- **GraphQL.** It uses the same transport as HTTP with different semantics. It's useful as a cleanup case once React has forced the abstraction, and not worth tackling before that.
- **Pact-style example contracts for React.** Storybook and snapshots already cover the specification and observation slots we need.

## What this commits us to

- The abstract claim in `boundary-semantics.md` becomes concrete at Phase 1.5 / Phase 2 (first multi-unit semantics, first non-HTTP pairing).
- Suss's positioning gets more specific: "behavioral analysis for code ↔ observable-behavior boundaries, with contract checking across whatever shapes the domain has." HTTP with OpenAPI was the first instance and React with Storybook is the second.
- The checker's current `checkContractAgreement` machinery is a down-payment on the multi-axis logic Phase 3 needs. Good.
- We can judge a future pack against this framework (what's the boundary? what are the code units? what's the observable channel? what contract shapes exist in that domain?) instead of designing from scratch each time.

## Open questions that'll get answered by doing

These are all on the critical path. Don't try to answer them ahead of time:

1. How faithful is the render tree when the child component being rendered is itself a variable, an HOC, or a conditional? Phase 1.4 finds out.
2. Does treating a handler as its own unit work for inline arrow functions, named handlers, and handlers a hook returns, without special cases? Phase 1.5 finds out.
3. Does parsing Storybook's CSF format statically give us useful stubs, or do we have to execute it? Phase 2 finds out.
4. Does the concept-design vision survive contact with the multi-axis finding model, or does it expose a design flaw in the current checker? Phase 3 finds out.

If any of these bend the design away from what this doc assumes, we update the doc first and rebuild the plan before we carry on.
