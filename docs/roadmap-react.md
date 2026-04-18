# React roadmap

Strategic plan for React as suss's first non-HTTP boundary. Design-only at this point — no code, but captures the direction so context survives compaction and implementation work stays on-thesis.

Related: [`boundary-semantics.md`](boundary-semantics.md) (the layered transport / semantics / recognition model), [`contracts.md`](contracts.md) (the contract-shape taxonomy — to be written).

## Where this fits in the bigger picture

Suss today ships one concrete boundary kind: HTTP. The IR is protocol-agnostic in its type shapes, but the checker, pairing, and packs have all converged on HTTP as the concrete case. The "behavioral understanding platform" positioning is credible only insofar as we can prove the abstraction works for a second boundary kind.

React is the first forcing function we're actually implementing. Why React rather than GraphQL (same transport, different semantics), RDS/Postgres (different substrate entirely, biggest latent value), or Vue (simpler technical case):

- **Adoption reach.** React has the largest developer base of the realistic targets. "Run `suss extract` on your React app" reaches more potential users than any other second-boundary choice.
- **Hardest declaration density.** React formalizes the least of any mainstream component framework. No `defineEmits`, no `defineSlots` — callbacks are arbitrary props, children are ad hoc. That forces the inferred summary to do the work that a Vue pack could lean on `defineEmits` for. If the IR survives React, it survives easier cases by induction.
- **Forces the `BoundarySemantics` refactor.** React's boundary (component ↔ DOM) shares no structure with HTTP's (client ↔ server). Pairing by `(method, path)` doesn't apply; status codes don't apply. The checker can't fake REST-shape and has to generalize.

## The boundary React actually has

Every React component source file looks like a function that takes props and returns JSX. But where's the *boundary* — the point where behavior becomes observable?

Not between parent and child component. They're both providers composing into the same output.

Not between component and React runtime — that's a platform relationship (like handler ↔ Express), not a contract between two peers.

The boundary is **component source ↔ DOM**. The DOM is where component behavior becomes observable. Snapshots, Playwright specs, Figma mocks, visual regression baselines — every existing contract shape for React describes behavior at the DOM boundary, not at the component interface.

This maps directly to the HTTP case:

| HTTP | React |
|---|---|
| Handler source | Component source |
| HTTP message on the wire | Rendered DOM tree + events |
| Client code | DOM (observed by tests, users, screen readers, visual-regression) |
| OpenAPI describes the wire | Snapshots / Storybook / Playwright / Figma describe the DOM |

So a React boundary in suss is `(module, component-name)`; the pairing key is the component identity; the "consumer" side is expressed through whatever stub shapes someone authored.

## Contract shapes in React are plural and partial

This is the sharpest departure from HTTP. For an HTTP endpoint, one canonical contract shape (OpenAPI or its framework-specific equivalent) tends to carry the whole declared contract. For React, *no single shape captures a full component contract*:

| Shape | Captures | Coverage | Epistemic character |
|---|---|---|---|
| TypeScript props interface | Input type surface | Full (for types) | Signature — necessary, not sufficient |
| Storybook stories | Named canonical scenarios + `args` + optional `play` | Curated set | Partial **spec** |
| Snapshots (Jest / Vitest) | Rendered tree for specific tests | Tested instances | Partial **observation** |
| Playwright / RTL | Event → effect sequences | Tested interactions | Behavioral observation |
| Figma / design tokens | Visual intent | Designer's scenarios | Design-source-of-truth |
| Inferred summary (from code) | All branching paths, state reads, effects | Full (for code behavior) | Structural **derivation** |

Three distinct kinds of contribution are visible here:

1. **Specs** (Storybook stories, `argTypes`) are *declarations* — "here are the canonical cases."
2. **Observations** (snapshots, Playwright runs) are *recordings* — "here's what happened last time we looked."
3. **Derivations** (inferred summary from code) are *computed* — "here's what the code's branching actually does."

Specs and observations are *partial*: a snapshot tells you what one configuration rendered, not what any other configuration would render. Pact has the same property in HTTP-land — recorded interactions aren't a full spec. The *derivation* is the only shape that enumerates all paths, and that's the inferred summary.

**The interesting findings for React come from inter-shape comparison:**

- Does the inferred summary cover every Storybook scenario? (Spec covered?)
- Does every snapshot correspond to an inferred path? (Observation ⊆ derivation, otherwise the code drifted from what the snapshot recorded.)
- Does Playwright's behavioral chain match the inferred handler's effects? (Behavior agreement.)
- Does Figma's scenario enumeration match Storybook's enumeration? (Design spec vs code spec.)

That's multi-axis contract agreement, not the single-axis `checkContractConsistency` we built for HTTP. It's an extension of `checkContractAgreement` (the Layer 2 pass) where "different sources" now means "different contract *shapes*," not just different schema flavors at the same shape layer.

## Why Storybook and Figma specifically

The user's framing — "Storybook will help for some, but Figma + inferred also needed" — is about coverage. No one shape is sufficient:

- **Storybook alone** catches "this scenario isn't supported by the code" when the code regresses against a canonical story. Misses: event handlers the component wires up but tests don't cover; visual/layout drift that stories don't enumerate; consumer-parent's expectations of the component.
- **Snapshots alone** are weaker specs — point-samples, not enumerations. Useful as regression anchors, not as contract sources.
- **Figma alone** catches visual/design drift but tells you nothing about event behavior or conditional rendering logic.
- **Inferred alone** tells you what the code does but not what it *should* do — no drift signal.

The full picture needs at least **Storybook + Figma + inferred**, because:

- Storybook = canonical scenarios spec (partial but authoritative where it speaks)
- Figma = design intent spec (partial, visual axis)
- Inferred = full branching derivation (complete but no ground truth)

Inferred crossed against Storybook + Figma gives multi-axis findings:
- "Component renders path X that no story covers" (inferred ⊄ Storybook)
- "Story expects scenario Y but code can't reach it" (Storybook ⊄ inferred)
- "Figma declares a visual variant that no story and no code path matches" (Figma ⊄ inferred ∪ Storybook)

Playwright and snapshots can be added later as additional shapes feeding the same agreement machinery. None of them is the *first* thing to build — Storybook + Figma + inferred cover the minimum viable cross-axis check.

## Phased plan

Each phase is scoped to answer specific forcing-function questions about the IR and checker. If a phase surfaces questions that invalidate later phases' assumptions, we stop and redesign — it's cheaper to discover the wrong shape at phase 2 than at phase 5.

### Phase 0 — Foundation docs (this doc + `docs/contracts.md`)

Write down what we know before writing code. `docs/contracts.md` captures the contract-shape taxonomy and epistemic character as a first-class architectural concept, cross-linking from `stubs.md`, `boundary-semantics.md`, and this roadmap.

**Forcing-function question:** is the contract-shape vocabulary we're introducing consistent and complete enough to plan against?

### Phase 1 — Inferred summaries for React components

Build `@suss/framework-react` (pattern pack) + whatever adapter extensions are needed so the TypeScript adapter can handle JSX/TSX properly.

What the inferred summary needs to capture per component:
- Input surface: destructured props, hooks called (and what they return), context consumed (`useContext`)
- Branching: conditional rendering (`cond && <X/>`, ternaries, early returns, list rendering via `.map`)
- Render output: the shape of the returned JSX, down to element names, attribute bindings, children
- Event handlers: which elements get which handler props; what the handlers' inferred behavior is (state changes, effect triggers, callback props invoked)
- Effects: `useEffect` body behavior — what state/refs it reads, what it does
- State: `useState` calls, their initial values, the setters that get called

**Forcing-function questions this phase answers:**
- Is `Output.render` rich enough to describe what a component actually produces? (Current shape is thin.)
- Do we need a new IR variant for "rendered tree shape" or can we reuse `TypeShape`?
- How do we express "this component renders another component" when we can only see the child as a JSX call, not a resolved function?
- How does `confidence` scale? React has tons of dynamic JSX that the extractor can't resolve.

**Explicitly deferred in Phase 1:**
- React Server Components specifics (async component bodies, server-only APIs)
- Class components (functional components are the modern case; class support can follow)
- HOCs and render props (higher-order composition; hard to track through)

### Phase 2 — Storybook as stub source

Build `@suss/stub-storybook` that reads `.stories.ts[x]` files and emits `BehavioralSummary[]` with `kind: "component"`.

Each story becomes one summary:
- `identity.name` = story name (`"Default"`, `"Loading"`)
- `identity.boundaryBinding` = component identity (module path + export name)
- `transitions[]` = the rendered tree given the story's `args`, plus any `play` function behavior
- `metadata.html?.storybook.{raw, argTypes}` carries provenance
- `confidence.source: "stub"`, `level: "medium"` (Storybook is spec but single-scenario)
- `metadata.storybook.provenance: "independent"` — story declarations are separate from component source

**Forcing-function questions:**
- Does `checkContractAgreement` generalize cleanly to inferred-vs-Storybook? The current impl compares `declaredContract.responses[]` sets; it needs to absorb "scenario sets with different coverage profiles."
- How does pairing work when the key isn't `(method, path)` but `(component)`? This is the first concrete use case for the `BoundarySemantics` refactor.

### Phase 3 — Figma as stub source

Build `@suss/stub-figma` that reads Figma files (via REST API or exported JSON) and emits component-boundary summaries capturing design intent.

Much harder than Storybook because:
- Figma's model is visual, not behavioral — no conditional rendering
- Mapping Figma components to code components requires naming conventions or explicit metadata
- Design tokens need their own contract shape (colors, spacing, typography as first-class values)

Scope for v0: read a Figma file, produce one stub summary per component variant declared there, with props extracted from variant properties. Defer: interaction prototypes, advanced component properties, design-token-level contract.

**Forcing-function questions:**
- Does the IR need a "visual tree" output type distinct from the DOM-structural one inferred summaries produce?
- How does the checker compare Figma's visual intent to code-rendered output? Is it shape-matching, layout-matching, or something fuzzier?
- What's the pairing key across Figma component name and code component name? String match is brittle; need something declarative.

### Phase 4 — Cross-axis contract agreement for React

Extend `checkContractAgreement` (or build a parallel `checkReactAgreement`) that runs the multi-axis findings described above:

- Inferred vs Storybook: "component renders path X that no story covers" / "story expects path Y that no code path reaches"
- Inferred vs Figma: "Figma declares variant V that no inferred render matches"
- Storybook vs Figma: "Figma has scenario Z not covered in stories (or vice versa)"

Severity ramp:
- Inferred missing coverage of an authored spec (Storybook or Figma) → `warning`
- Spec declares a scenario the code can't produce → `error` (code can't honor the contract)
- Figma-only scenarios absent from stories → `info` (design may be ahead of implementation)

**Forcing-function questions:**
- Does `contractDisagreement` generalize, or do we need a new finding kind per axis?
- How does `dedupeFindings` interact with multi-axis findings — are they eligible for dedup or genuinely distinct?
- Is the `sources` attribution on findings rich enough to tell you which shape contributed what?

## IR and checker changes the plan implies

Captured here so the refactor work is visible, not incidental:

1. **`BoundaryBinding` generalization.** HTTP bias in `(protocol, method, path, framework)` becomes real pressure at Phase 1. The `boundary-semantics.md` design needs to land somewhere around here — `BoundaryBinding` splits into `transport + semantics(variant)` with React's variant being `{ kind: "react-component", module, componentName }`.

2. **`BoundarySemantics` interface.** Pairing, discriminator extraction, payload extraction abstracted over boundary kind. The HTTP impl is the first; the React impl is the second. Planned in `boundary-semantics.md`; implementation blocks Phase 1 in any clean form.

3. **`Output.render` expansion.** Currently `{ component: string, props?: Record<string, unknown> }`. Needs to describe an actual rendered tree: element name, attributes, children, event handlers wired up, etc. Phase 1 designs this; subsequent phases consume it.

4. **Possibly: separate `Output` variant for visual intent.** Figma's output is visual, not DOM-structural. May or may not fit in the render variant; decide during Phase 3.

5. **Contract shape tagging in metadata.** Currently `metadata.http.declaredContract` is a single-shape field. Multi-axis contracts may need `metadata.component.{storybook, figma, playwright}.*` namespacing or a more generic shape-tagged structure. Designed in `docs/contracts.md`.

## What we're explicitly deferring

So the shape of "done" is obvious:

- **Database boundaries (RDS / Postgres / Prisma).** Bigger latent value than React; picked up after React is the next-but-one frontier. Schema-shaped so it doesn't stress the contracts taxonomy the way React does.
- **GraphQL.** Same transport as HTTP but different semantics. Useful as a cleanup case after React has forced the abstraction; not worth tackling before.
- **React Server Components-specific analysis.** Async components, server-only APIs, streaming. Modern but adds another axis.
- **Class components.** Nearly-dead code form in new React; can be bolted on if demand appears.
- **Figma design-token as a first-class contract shape.** Phase 3 covers component-shape intent; token-level (colors, typography) is deferred further.
- **Pact-style example contracts.** Could work for React (recorded scenarios from a running app) but Storybook + snapshots cover the spec + observation slots we need to prove the multi-shape claim.

## What this commits us to

- The abstract claim in `boundary-semantics.md` becomes concrete in Phase 1. No more deferring.
- Suss's positioning sharpens: "behavioral analysis for code ↔ observable-behavior boundaries, with contract checking across whatever shapes the domain has." HTTP-with-OpenAPI was the first instance; React-with-Storybook-and-Figma is the second.
- The checker's current `checkContractAgreement` machinery is a down-payment on the multi-axis logic Phase 4 needs. Good.
- Future packs can be assessed against this framework: what's the boundary? what's the observable channel? what contract shapes exist in that domain? — without needing fresh design each time.

## Open questions that'll get answered by doing

These are on the critical path; don't try to pre-answer them:

1. How honest is `Output.render` when the rendered child component is itself a variable/HOC/conditional? Phase 1 finds out.
2. Does Storybook's CSF format make story extraction tractable without running the story (static parsing) or do we need to execute them? Phase 2 finds out.
3. Is Figma's component-to-code mapping solvable via naming convention alone, or do we need metadata in the Figma file? Phase 3 finds out.
4. Does the "concepts vision" survive contact with the multi-axis finding model — or does it surface a design flaw in the current checker? Phase 4 finds out.

If any of these bend the design away from what this doc assumes, we update the doc first and rebuild the plan before continuing.
