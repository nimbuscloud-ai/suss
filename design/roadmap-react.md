# React roadmap

This is the plan for React as suss's first boundary that is not HTTP. We wrote the direction down so the context is not lost between sessions and the implementation stays on course. Phases we have shipped are marked ✅. Everything else stays a design until the phase before it has answered the questions it was meant to force.

Related: [`boundary-semantics.md`](../docs/theory/boundary-semantics.md) (the layering of transport, semantics and recognition) and [`contracts.md`](../docs/why/kinds-of-contract.md) (the taxonomy of five contract shapes).

## Where this fits in the bigger picture

Today suss ships one concrete kind of boundary: HTTP. The types the IR defines do not assume any protocol, but the checker, the pairing and the packs all ended up built around HTTP. We can only call suss a "behavioral understanding platform" if we can show the abstraction works for a second kind of boundary.

React is the first case we're implementing to force that. We picked it over GraphQL (same transport, different semantics), RDS/Postgres (a completely different substrate, with the most untapped value) and Vue (the simpler technical case) for three reasons:

- **Adoption reach.** React has the largest developer base of the realistic targets.
- **It declares the least.** React formalizes less than any other mainstream component framework. It has no `defineEmits` and no `defineSlots`. Callbacks are arbitrary props, and children are ad hoc. If the IR works for React, it will work for the easier cases too.
- **It forces the `BoundarySemantics` refactor.** React's boundary (component ↔ DOM) has nothing in common with HTTP's (client ↔ server). Pairing by `(method, path)` doesn't apply, and neither do status codes. The checker can't pretend everything looks like REST, so it has to generalize.

## A React component is N code units

This is the key framing decision, so we state it plainly before the phases.

A React component, as something you see in a source file, is *not* one behavioral unit. It is a cluster of them:

- The **render body** runs on every render. Its inputs are props, state and context. Its output is a JSX tree, and its effects are reads of state and invocations of child components.
- Each **event handler** is its own entry point. Its inputs are the synthetic event plus the state and props it closes over, and its outputs are state changes and calls to callback props.
- Each **`useEffect` body** is its own unit. Its inputs are the values in the dependency array. Its outputs are side effects such as subscriptions, network calls and DOM writes, and it has a cleanup sub-unit.
- Each **`useMemo` or `useCallback` body** has the same form as a fragment of render, keyed on its deps.

They share an identity (the same component module and export) and they share state (hooks and closures). But they have different inputs and different outputs, and they fire at different times. Treating them as one "lifecycle summary" would blur together events that mean different things, and we would lose the information that makes React findings useful.

This reuses the HTTP abstraction without adding concepts. A single Express handler file can register `app.get("/users", h1)` and `app.post("/users", h2)`, which are two code units in one module. In the same way, a React component file exports one default component whose render, handlers and effects are several code units with a shared identity prefix. The `BoundaryBinding.semantics` layer tells them apart (`render` vs `event-handler(name="onClick")` vs `effect(index=0)`).

This is also where the **theoretical grounding** comes in. In Daniel Jackson's concept-design framework (MIT; see [*The Essence of Software*](https://essenceofsoftware.com/), [*Concept Design Moves*](https://people.csail.mit.edu/dnj/publications/nfm-design-moves-22.pdf), [*What You See Is What It Does*](https://arxiv.org/abs/2508.14511)), a concept is a self-contained unit with state, actions and a purpose. Synchronizations are rules of the form "when action A₁ in concept C₁ happens, action A₂ in concept C₂ happens." In those terms:

- A suss code unit ≈ a concept's action (one behavior something can trigger)
- Shared closure or hook state ≈ the concept's state
- `setState` → re-render is a synchronization: "when `onClick.setState(n)` fires, `render` observes n and produces new JSX"
- The cluster of units that share a React component identity ≈ one concept instance

We don't adopt all of Jackson's vocabulary. "Purpose" needs intent declarations that suss doesn't have. But the structures line up closely, so the decision to use N units per component has a theoretical basis as well as a practical one.

We diverge from Jackson in two deliberate ways:

1. **There is no intent.** A Jackson concept declares its purpose top-down, and suss infers behavior bottom-up. The closest substitute is a `contractDisagreement` finding. It fires when observed behavior contradicts a declared contract, which is as close as suss gets to "purpose violated."
2. **There is no genericity.** Jackson concepts are reusable design building blocks (like `Upvote` or `Follow`). suss summaries describe one instance. The goal of reducing opaqueness recursively leaves room for clusters that keep recurring to show up as candidate concepts, but that is future work and not part of v0.

Further reading: Daniel Jackson, [*Concept Design Moves*](https://people.csail.mit.edu/dnj/publications/nfm-design-moves-22.pdf) (NFM 2022); Eagon Meng & Daniel Jackson, [*What You See Is What It Does*](https://arxiv.org/abs/2508.14511) (SPLASH Onward! 2025); Jackson, [*The Essence of Software*](https://essenceofsoftware.com/) (Princeton, 2021). The long-form mapping (audience indexing, failure modes, PRDs as concept declarations) is in [`concept-design.md`](../docs/theory/prior-art.md).

## The boundary React actually has

Every React component source file looks like a function that takes props and returns JSX. So where is the *boundary*, the point where behavior becomes observable?

It is not between a parent and a child component. They are both providers contributing to the same output.

It is not between a component and the React runtime either. That is a relationship with a platform (like a handler with Express), and not a contract between two peers.

The boundary is **component source ↔ DOM / user**, because the DOM is where a component's behavior becomes observable. Snapshots, Playwright specs, visual regression baselines and screen-reader behavior all describe what a React component does at the DOM, and none of them describe the component interface. The same is true of every other existing contract shape for React.

This maps directly onto the HTTP case:

| HTTP | React |
|---|---|
| Handler source | Component code units (render, handlers, effects) |
| HTTP message on the wire | Rendered DOM tree + dispatched events |
| Client code | DOM (observed by tests, users, screen readers, visual-regression) |
| OpenAPI describes the wire | Storybook / snapshots / Playwright describe the DOM |

So a React boundary in suss is `(module, component-name, unit-kind)`. The pairing key is the component identity plus the unit kind. The "consumer" side comes from whatever stub shapes someone wrote, with Storybook first.

## Contract shapes in React are plural and partial

This is where React differs most from HTTP. For an HTTP endpoint, one canonical contract shape (OpenAPI or the framework's own equivalent) usually contains the whole declared contract. For React, *no single shape covers a component's full contract*:

| Shape | Captures | Coverage | Epistemic character |
|---|---|---|---|
| TypeScript props interface | Input type surface | Full (for types) | Signature; necessary, not sufficient |
| Storybook stories | Named canonical scenarios + `args` + optional `play` | Curated set | Partial **specification** |
| Snapshots (Jest / Vitest) | Rendered tree for specific tests | Tested instances | Partial **observation** |
| Playwright / RTL | Event → effect sequences | Tested interactions | Behavioral **observation** |
| Figma / design tokens | Visual intent | Designer's scenarios | Design-source-of-truth (see punt below) |
| Inferred summary (from code) | All branching paths, state reads, effects | Full (for code behavior) | Structural **derivation** |

The shapes contribute three different kinds of knowledge:

1. **Specifications** are *declarations*: Storybook stories, `argTypes`, props interfaces.
2. **Observations** are *recordings*: snapshots, Playwright runs, RTL assertions.
3. **Derivations** are *computed*: the summary inferred from code.

Specifications and observations are *partial*. A snapshot tells you what one configuration rendered, and nothing about any other configuration. The *derivation* is the only shape that lists every path, and suss produces it.

**The interesting findings for React come from comparing the shapes with each other:**

- Does the inferred summary cover every Storybook scenario? (Is the specification satisfied?)
- Does every snapshot correspond to an inferred path? (Observation ⊆ derivation, or else the code drifted.)
- Does Playwright's chain of events match the effects of the inferred handler unit? (Do the shapes agree on behavior?)
- Does the Storybook spec list paths the code can actually reach? (Is the spec feasible?)

That is agreement across several contract shapes at once, where the `checkContractConsistency` we built for HTTP compares along one axis. It extends `checkContractAgreement` (the Layer 2 pass), so that "different sources" now covers different contract *shapes* as well as different schema flavors.

### Figma is punted

The earlier plan listed Figma as a main stub source. We've put it off, for three reasons:

1. **It usually isn't committed.** Figma files live in a SaaS product. At best the repo has a URL to one in a comment.
2. **It isn't definitive.** Wireframes often differ from what ships, and people keep editing Figma files after the code lands. A design file is rarely the contract.
3. **Extraction costs a lot for a signal we can't use yet.** The Figma REST API plus a mapping from naming conventions is a lot of integration work to do before we know which cross-shape check it would feed.

If it comes back, it will be an explicit, opt-in `@suss/contract-figma-url` that reads a URL reference and reports a `lowConfidence` signal about visual intent. It will never be a source of hard findings. It is not on the critical path.

## Why Storybook first

After dropping Figma, the contract shapes left are **Storybook and the inferred summary, with Playwright and snapshots later**. Storybook is the first stub we'll build because:

- People usually commit Storybook stories to the repo (`*.stories.tsx`), which they don't do with Figma.
- We can parse CSF (Component Story Format) statically, so basic extraction doesn't have to run anything.
- `args` and `argTypes` give a canonical spec: "here's a set of prop configurations this component supports."
- Optional `play` functions are behavioral observations, and they pair directly with event-handler code units.

Storybook alone is enough to prove that comparing several shapes works. Comparing the inferred derivation with the Storybook specification gives us the first useful finding across shapes, and the same machinery extends to Playwright and snapshots by adding readers.

## Phased plan

Each phase is scoped to answer particular questions about the IR and the checker. If a phase raises questions that break what a later phase assumes, we stop and redesign. Finding out the design is wrong at Phase 1.6 is cheaper than finding out at Phase 3.

### Phase 0: Foundation docs ✅

`docs/why/kinds-of-contract.md` sets out the taxonomy of contract shapes and their epistemic character. `design/roadmap-react.md` (this doc) sets out the React plan. `docs/theory/boundary-semantics.md` sets out the layering of transport, semantics and recognition.

### Phase 1: Inferred summaries for React components (in progress)

Build `@suss/framework-react` (a pattern pack) plus extensions to the adapter, so the TypeScript adapter can discover components, extract props and walk JSX trees. We split the work into one sub-phase per kind of code unit, so each one raises its own question about the IR.

| Sub-phase | Status | Output |
|---|---|---|
| 1.1 Function-component discovery + JSX-return terminal | ✅ | Default-exported function components become `component` code units. A JSX return becomes a `render` terminal that records the root element's name. New `jsxReturn` TerminalMatch variant. |
| 1.2 Destructured-prop Inputs + type resolution | ✅ | New `componentProps` InputMappingPattern: one Input per destructured name, with the type TypeScript resolves for it. When the props aren't destructured it falls back to the whole object. |
| 1.3 Hook-call recognition (`useState`, `useRef`, etc.) | ✅ (by-product) | The existing `extractDependencyCalls` picks these up for free. A hook shows up when a condition or an output references its return value. |
| 1.5b Effect-body capture + fall-through terminals | ✅ | A call written as a bare expression statement in a function body becomes an `invocation` `RawEffect` on the default branch (`setCount(n); onChange(n);`). A new `functionFallthrough` `TerminalMatch` variant lets a pack opt into "emit a default transition when no explicit return or throw covers the exit path". The HTTP packs deliberately don't opt in, so a handler that looks buggy stays empty and gap detection can see it. The sub-unit scaffolding (React handlers, `useEffect` bodies, Node `.on(...)` listeners) does opt in. We filter out calls whose source line matches a terminal we already matched (`res.json(...)` in Express, for instance), so nothing is counted twice. |
| 1.4 Inline JSX conditionals (`cond && <X/>`, ternaries) | ✅ | `RenderNode` gained a `conditional` variant: `{type: "conditional"; condition; then; else: RenderNode \| null}`. The adapter breaks down `{cond && <X/>}`, `{cond ? <A/> : <B/>}` and `{cond ? <X/> : null}`, and it handles the `false` and `undefined` values that render nothing, and parenthesised JSX. For `{cond ? nonJsx : <Fallback/>}` it promotes the JSX branch and negates the condition as text, to `!(cond)`. `\|\|`, `.map()` and other expressions that are not conditionals stay as opaque `expression` nodes. v0 keeps the condition text word for word. Breaking the test expression down into a structured predicate is a follow-up. |
| 1.5 Event handlers as separate code units | ✅ | Each `onClick={fn}` or inline `onClick={() => ...}` becomes its own `handler`-kind summary with the component's identity prefix. Named locals are called `ComponentName.functionName`, and inline arrows are called `ComponentName.tag.propName[#N]`. A handler that only forwards a prop (`onClick={props.onDelete}`) is skipped. An adapter post-pass (`synthesizeReactHandlers`) does this, so the pack stays declarative. Pulling effects out of a body (bare `setState()` call statements) is still limited, and 1.5b follows up on it. |
| 1.6 Nested render tree (Output.render.root) | ✅ | `RenderNode` is a recursive IR node (element, text, or expression), and `Output.render.root` contains the full tree with its children. |
| 1.6b JSX attributes on render-tree element nodes | ✅ | `RenderNode.element` gained an optional `attrs?: Record<string, string>`. It maps every JSX attribute to the raw source text of its value: a string literal includes its quotes, an expression includes its full source, and boolean shorthand maps to `""`. A spread (`{...props}`) shows up as a `...exprText` key. None of this is specific to a framework, and the adapter reads no React meaning into it. Downstream consumers (the Storybook matcher, the cross-shape checker) combine the attributes with the pack's naming rule to work out which handler summary an attribute refers to, when they need to. For example, `attrs.onClick = "handleSubmit"` plus the `Form.handleSubmit` naming gives a reference to a summary. |
| 1.7 `useEffect` bodies as code units | ✅ | Each `useEffect(fn, deps?)` becomes a `handler`-kind summary (`metadata.react.kind = "effect"`) called `ComponentName.effect#N`, numbered in source order. The source text of the deps array is recorded on `metadata.react.deps`. It is null when there is no array, meaning the effect re-runs every render, and `"[]"` means it runs only on mount. Inputs are deferred. A `useEffect` callback closes over its deps and does not receive them as parameters, so the input mapping by parameter position is empty. The question this phase had to answer: one summary per useEffect, with its branches and effects, is enough. Nothing needs a separate cleanup sub-unit at this level, because a cleanup return already shows up as one of the effect's own `return` transitions. |

**Questions this phase answers (updated):**

- Is `Output.render` rich enough to describe what a component produces? (Phase 1.6 shipped.)
- How does the pattern-pack interface support finding several units in one file? (Phase 1.5.)
- Do event handlers and effects need new `CodeUnitKind`s, or do they fit inside `component` and `hook`? (Phase 1.5 and 1.7.)
- How does `confidence` scale? React has a lot of dynamic JSX the extractor can't resolve. (This runs through every sub-phase, and each one watches it.)

**Deliberately left out of all of Phase 1:**

- React Server Components (async bodies, server-only APIs)
- Class components (functional components are the dominant style)
- HOCs and render props (higher-order composition, which is hard to track through)
- Custom hooks (you call them like any other function, so extraction recurses into them and v0 needs no special case)

### On Storybook's scope

Storybook is a useful *proof of concept* for comparing shapes. It let us build `subUnits`, the cross-shape finding kinds and the extract, stub and check pipeline against a target we could handle. But Storybook covers scenarios for components people reuse. The interesting screen states in a production app won't be in Storybook anyway: full-page flows, several components interacting, and error states that only appear once you route through the app.

The more valuable sources of observations are **test runtimes that drive the whole UI**: Playwright, Cypress, Vitest with Testing Library, and Storybook portable stories composed into those runtimes (`composeStories`). Their play functions and spec sequences are *behavioral observations* in the sense the contracts taxonomy uses. `await userEvent.click(button)` means the inferred handler should fire, and `expect(page.getByText("Saved"))` means the inferred render should produce that text. TypeScript can't catch those findings, and they are the ones worth paying for.

The Storybook stub stays shipped for the coverage it gives at the component level. Any further Storybook work (snapshots, play functions) becomes part of a wider effort on observation stubs, together with Playwright and Cypress. See Phase 4 below.

### Phase 2: Storybook as stub source (v0 shipped)

`@suss/contract-storybook` reads `.stories.ts[x]` files statically, without running them, and emits `BehavioralSummary[]` with `kind: "component"`. Each story exported by name becomes one summary:

- `identity.name` = `{component}.{story}` (e.g. `Button.Primary`)
- `identity.boundaryBinding` = a function-call binding with `transport: "in-process"`, `recognition: "react"` and the component's name as its export
- `inputs` = one `parameter` Input per arg, with the source text of the arg's value kept on `shape.ref.name`
- `transitions` = one default `render` transition that gives the component's name
- `metadata.component.storybook.{story, component, args, provenance: "independent"}`
- `confidence.source: "derived"`, `level: "medium"`

It covers the CSF3 variants: `const meta = {...}; export default meta;`, a direct `export default {...}`, and `{...} satisfies Meta<typeof T>` on both the meta and the stories. It also picks up args written as shorthand properties.

**Left for after v0:**
- Parsing `play` functions (the event sequences an interactive story runs). Once Phase 3 lands, they will cross-reference the handler units from Phase 1.5
- The per-arg metadata in `argTypes` (control type, options)
- Resolving a component across files. It currently records the component's identifier and doesn't follow the import to a module path
- CSF1 / MDX / decorators / parameters

**Questions now answered:**

- *You can write Storybook stubs without executing the stories* ✓, because CSF3 can be parsed statically.
- *The pairing key for a component boundary is `(componentName, storyName)` with framework `react`*, which differs from HTTP's `(method, path)`. That confirms we need `BoundaryBinding.semantics` to have several variants when the `BoundarySemantics` refactor lands.

**Still open (for Phase 3):**
- Does `checkContractAgreement` generalize to comparing inferred summaries with Storybook?
- Do play-function sequences pair with handler sub-units?

### Phase 3: Cross-shape contract agreement for React (v0 shipped)

`checkComponentStoryAgreement` in `@suss/checker` pairs Storybook stubs with inferred React component summaries by component name. It emits two kinds of finding:

- `scenarioArgUnknown`: a story references a prop the component doesn't declare. This catches out-of-date stories and renamed props.
- `scenarioCoverageGap`: a prop gates a conditional branch in the component's inferred logic and no story supplies that prop, so no declared scenario exercises the branches that depend on it. The check walks the structured `Predicate` and `ValueRef` IR to collect the names of the inputs that gate a branch. When a predicate is opaque, it falls back to a regex over the source text.

It deliberately does **not** report a mismatch between an arg's value and the declared type. TypeScript already catches `label: 42` against `label: string` through CSF3's `satisfies Meta<typeof Component>`, so repeating that check would only add noise.

The check runs inside `checkAll` next to `checkContractAgreement`. We picked dedicated finding kinds instead of reusing `contractDisagreement`, because a story against a component isn't quite "two contracts disagreeing". It is a scenario against an implementation, and that deserves its own finding kind.

**Integration test:** `packages/cli/src/storybookIntegration.test.ts` runs the whole pipeline (extract the React fixtures, stub the Storybook fixtures, run `checkAll`). It asserts that `scenarioArgUnknown` fires on the `Disabled` story in `Button.stories.tsx`, which uses a `disabled` prop that Button.tsx doesn't declare. It also asserts the positive case: the `Loaded` story in UserCard.stories.tsx covers the `user` prop properly, so no coverage gap fires there.

**Left for after v0:**
- Inferred handlers against Storybook `play` sequences. We need to parse play functions first
- Inferred render against the content of a Storybook snapshot. We need a snapshot stub first
- Coverage of branch values ("the component has a branch for `user.deletedAt === true` but no story provides such a user"). We need to partially evaluate predicates against arg values first
- Cross-checks against observation shapes (Playwright, Cypress): see Phase 4

### Phase 4: Observation-shape stubs (Playwright / Cypress / portable stories)

For React, the cross-shape findings with the most signal come from the *sequences of observable interactions* that a full-app test runtime records, and Storybook args have little of that. Parsing those sequences gets us findings that TypeScript, Storybook and checking inferred summaries cannot give us on their own:

- **Dead click:** a Playwright test does `userEvent.click(button)` on a `<button>` that has no handler in the inferred render tree.
- **Asserted text the render can't produce:** the test runs `expect(page.getByText("Welcome back"))`, but the inferred render tree never emits that text under the args the test implies.
- **State assertion no handler reaches:** the test runs `await waitFor(() => expect(valueIsX))`, but no handler's inferred effects produce that state.

The stubs to build when we are ready are `@suss/contract-playwright` (which parses `.spec.ts` files), `@suss/contract-cypress` (the same for Cypress), and parsing of Storybook `play` functions (added to `@suss/contract-storybook`). Each one emits observation-kind summaries, and the cross-shape checker pairs them with handler sub-units and render-tree elements. We should do this before putting more work into Storybook, because play functions and E2E specs are where most of the behavior of a non-trivial UI shows up.

### Snapshot reader (opportunistic)

A snapshot reader, which turns `__snapshots__/*.snap` into partial observation summaries, comes as an extra pack alongside the Phase 4 readers. Phase 3 v0 has shipped the cross-shape machinery it would feed. Neither needs new IR work, and both feed the same checker extension.

## IR and checker changes the plan implies

We list these here so the refactor work is planned and does not happen by accident:

1. **Generalize `BoundaryBinding`.** `(protocol, method, path, framework)` becomes `transport + semantics(variant) + recognition`. React's semantics variant is `{ kind: "react-component-unit", module, componentName, unitKind: "render" | "handler" | "effect", unitName? }`. This is what makes pairing possible in Phase 1.5 and Phase 2.

2. **A `BoundarySemantics` interface.** Pairing, extracting discriminators and extracting payloads all get abstracted over the kind of boundary. HTTP is the first implementation and React is the second. Until this exists, there is no maintainable way to build Phase 2.

3. **`Output.render.root`** ✅. The recursive `RenderNode` tree shipped in Phase 1.6.

4. **Discovering several units in `PatternPack`.** Today a pack says "a default export gives one component." Phase 1.5 needs "a default export gives one component unit AND one handler unit for every prop like `onClick` in the render tree." Either the pack interface grows a case for discovering several units, or the adapter builds the sibling units from the render tree. We prefer the second, because it keeps the pack declarative.

5. **Tagging the contract shape in metadata.** `metadata.component.storybook.*`, `metadata.component.snapshot.*` and so on, next to `metadata.http.*`. This extends the pattern from `docs/reference/summary-format.md`.

## What we're explicitly deferring

So that "done" has a clear meaning:

- **Figma as a main stub source** (see above).
- **React Server Components**: async component bodies, server-only APIs, streaming.
- **Class components**: a form that is almost never used in new React code.
- **HOCs and render props**: higher-order composition, which is hard to track through.
- **Custom hooks as separate code units**: extraction can recurse into them when needed, and we have planned nothing special for them.
- **Database boundaries (RDS / Postgres / Prisma).** These have more untapped value than React, and we pick them up after React. They are shaped like schemas, so they don't test the contracts taxonomy the way React does.
- **GraphQL.** It uses the same transport as HTTP with different semantics. It is a useful tidy-up case once React has forced the abstraction, and not worth tackling before that.
- **Pact-style example contracts for React.** Storybook and snapshots already cover the specification and observation slots we need.

## What this commits us to

- The abstract claim in `boundary-semantics.md` becomes concrete at Phase 1.5 and Phase 2, with the first semantics that cover several units and the first pairing outside HTTP.
- suss's positioning gets more specific: "behavioral analysis for code ↔ observable-behavior boundaries, with contract checking across whatever shapes the domain has." HTTP with OpenAPI was the first instance, and React with Storybook is the second.
- The checker's current `checkContractAgreement` code is a first installment on the logic Phase 3 needs for comparing across several axes, and that is a good position to be in.
- We can judge a future pack with the same questions (what is the boundary, what are the code units, what is the observable channel, what contract shapes exist in that domain) instead of designing from scratch each time.

## Open questions that'll get answered by doing

These are all on the critical path. Don't try to answer them ahead of time:

1. How faithful is the render tree when the child component being rendered is itself a variable, an HOC or a conditional? Phase 1.4 finds out.
2. Does treating a handler as its own unit work for inline arrow functions, named handlers and handlers a hook returns, without special cases? Phase 1.5 finds out.
3. Does parsing Storybook's CSF format statically give us useful stubs, or do we have to execute it? Phase 2 finds out.
4. Does the concept-design vision work with a finding model that compares several axes, or does it show a design flaw in the current checker? Phase 3 finds out.

If any of these push the design away from what this doc assumes, we update the doc first and rebuild the plan before we carry on.
